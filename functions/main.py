import functions_framework
from anthropic import AnthropicVertex
from flask_cors import cross_origin
import json
import base64
import httpx

# Initialize the Anthropic client
LOCATION = "us-east5"
PROJECT_ID = "wz-cloud-claude"
MODEL = "claude-opus-4@20250514"

client = AnthropicVertex(region=LOCATION, project_id=PROJECT_ID)

@functions_framework.http
@cross_origin()
def chat(request):
    """
    Single Cloud Function to handle all chat scenarios with Claude.
    
    Expects JSON payload with:
    - messages: Array of message objects with 'role' and 'content'
    - image: (optional) Object with 'data' (base64) and 'media_type'
    - system_prompt: (optional) System prompt for context
    - use_cache: (optional) Boolean to enable prompt caching (default: True)
    - max_tokens: (optional) Maximum tokens for response (default: 2048)
    
    Features:
    - Always uses thinking mode with 6553 token budget
    - Supports prompt caching
    - Handles both text and image inputs
    - Returns streamed content (note: Cloud Functions return complete response)
    """
    
    # Handle preflight requests
    if request.method == 'OPTIONS':
        headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '3600'
        }
        return ('', 204, headers)
    
    try:
        request_json = request.get_json(silent=True)
        
        if not request_json or 'messages' not in request_json:
            return {'error': 'Messages are required'}, 400
        
        messages = request_json.get('messages', [])
        image_data = request_json.get('image')
        system_prompt = request_json.get('system_prompt')
        use_cache = request_json.get('use_cache', True)
        max_tokens = request_json.get('max_tokens', 8192)  # Maximum output tokens
        
        # Prepare messages (excluding system prompt)
        all_messages = []
        
        # Process regular messages
        for i, msg in enumerate(messages):
            # If this is the last message and we have an image, combine them
            if i == len(messages) - 1 and image_data:
                message_content = [
                    {
                        'type': 'image',
                        'source': {
                            'type': 'base64',
                            'media_type': image_data['media_type'],
                            'data': image_data['data']
                        }
                    },
                    {
                        'type': 'text',
                        'text': msg['content']
                    }
                ]
                all_messages.append({
                    'role': msg['role'],
                    'content': message_content
                })
            else:
                # Regular text message
                # Always use content blocks structure for consistency
                content_block = {
                    'type': 'text',
                    'text': msg['content']
                }
                
                # Add caching to assistant messages if enabled
                if use_cache and msg['role'] == 'assistant' and i < len(messages) - 2:
                    content_block['cache_control'] = {'type': 'ephemeral'}
                
                message = {
                    'role': msg['role'],
                    'content': [content_block]
                }
                all_messages.append(message)
        
        # Prepare the message options with thinking enabled
        message_options = {
            'max_tokens': max_tokens,
            'messages': all_messages,
            'model': MODEL,
            'thinking': {
                'type': 'enabled',
                'budget_tokens': 6553
            }
        }
        
        # Add system prompt as top-level parameter if provided
        if system_prompt:
            system_content = {
                'type': 'text',
                'text': system_prompt
            }
            if use_cache:
                system_content['cache_control'] = {'type': 'ephemeral'}
            message_options['system'] = [system_content]
        
        # Stream the response (Note: Cloud Functions collect full response)
        full_response = ''
        thinking_content = ''
        is_thinking = False
        chunks = []
        
        with client.messages.stream(**message_options) as stream:
            for event in stream:
                if hasattr(event, 'type'):
                    if event.type == 'content_block_start':
                        if hasattr(event, 'content_block') and event.content_block.type == 'thinking':
                            is_thinking = True
                    elif event.type == 'content_block_delta':
                        if hasattr(event, 'delta') and hasattr(event.delta, 'text'):
                            text = event.delta.text
                            if is_thinking:
                                thinking_content += text
                            else:
                                full_response += text
                                # Collect chunks for potential future streaming
                                chunks.append({
                                    'type': 'text_delta',
                                    'text': text
                                })
                    elif event.type == 'content_block_stop':
                        if is_thinking:
                            is_thinking = False
        
        # Get usage stats
        usage = {
            'input_tokens': stream.current_message_snapshot.usage.input_tokens,
            'output_tokens': stream.current_message_snapshot.usage.output_tokens
        }
        
        # Check if prompt was cached
        if hasattr(stream.current_message_snapshot.usage, 'cache_creation_input_tokens'):
            usage['cache_creation_tokens'] = stream.current_message_snapshot.usage.cache_creation_input_tokens
        if hasattr(stream.current_message_snapshot.usage, 'cache_read_input_tokens'):
            usage['cache_read_tokens'] = stream.current_message_snapshot.usage.cache_read_input_tokens
        
        # Return the complete response
        # Note: For true streaming, deploy this as a Cloud Run service instead
        return {
            'content': full_response,
            'thinking': thinking_content if thinking_content else None,
            'usage': usage,
            'chunks': chunks,  # Include chunks for frontend simulation of streaming
            'cached': 'cache_read_tokens' in usage  # Indicate if cache was used
        }
        
    except Exception as e:
        print(f"Error in chat function: {str(e)}")
        return {'error': str(e)}, 500
