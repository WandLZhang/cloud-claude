import functions_framework
from anthropic import AnthropicVertex
from flask_cors import cross_origin
import json
import base64
import httpx
import firebase_admin
from firebase_admin import credentials, storage
from urllib.parse import urlparse, unquote

# Initialize Firebase Admin
if not firebase_admin._apps:
    firebase_admin.initialize_app()

# Initialize the Anthropic client
LOCATION = "us-east5"
PROJECT_ID = "wz-cloud-claude"
MODEL = "claude-opus-4@20250514"

client = AnthropicVertex(region=LOCATION, project_id=PROJECT_ID)

def download_image_from_storage(url):
    """Download image from Firebase Storage using Admin SDK."""
    try:
        # Parse the URL to get the file path
        parsed_url = urlparse(url)
        
        # Extract the path from Firebase Storage URL
        # Format: https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encoded_path}?...
        if 'firebasestorage.googleapis.com' in parsed_url.netloc:
            path_parts = parsed_url.path.split('/o/')
            if len(path_parts) > 1:
                # Decode the URL-encoded path
                file_path = unquote(path_parts[1].split('?')[0])
                
                # Get the storage bucket
                bucket = storage.bucket('wz-cloud-claude.firebasestorage.app')
                
                # Get the blob
                blob = bucket.blob(file_path)
                
                # Download the file content
                content = blob.download_as_bytes()
                
                # Get content type
                content_type = blob.content_type or 'image/jpeg'
                
                # Convert to base64
                base64_data = base64.b64encode(content).decode('utf-8')
                
                return base64_data, content_type
        
        raise ValueError("Invalid Firebase Storage URL")
        
    except Exception as e:
        print(f"Error downloading image from Firebase Storage: {str(e)}")
        raise

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
    - Streams responses using Server-Sent Events (SSE)
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
        
        # Handle image data - convert URL to base64 if needed
        if image_data:
            # Check if it's a URL or base64 data
            if 'url' in image_data and image_data['url'].startswith('http'):
                # Download image from Firebase Storage URL using Admin SDK
                base64_data, content_type = download_image_from_storage(image_data['url'])
                image_data = {
                    'data': base64_data,
                    'media_type': content_type
                }
            elif 'url' in image_data and image_data['url'].startswith('data:'):
                # Extract base64 from data URL
                base64_data = image_data['url'].split(',')[1]
                media_type = image_data.get('type', 'image/jpeg')
                image_data = {
                    'data': base64_data,
                    'media_type': media_type
                }
            # If 'data' key already exists, use as is
        
        # Prepare messages (excluding system prompt)
        all_messages = []
        
        # First pass: collect assistant message indices with content
        assistant_indices = []
        for i, msg in enumerate(messages):
            if msg['role'] == 'assistant' and msg.get('content', '').strip():
                assistant_indices.append(i)
        
        # Determine which assistant messages to cache (last 2, to leave room for system prompt)
        # We have max 4 cache blocks, 1 is used by system prompt, so we can cache up to 3 assistant messages
        # But to be safe, we'll cache only the last 2 assistant messages
        max_cached_assistant_messages = 2
        cached_assistant_indices = set(assistant_indices[-max_cached_assistant_messages:]) if assistant_indices else set()
        
        print(f"Assistant message indices: {assistant_indices}")
        print(f"Will cache assistant messages at indices: {cached_assistant_indices}")
        
        # Process regular messages
        for i, msg in enumerate(messages):
            print(f"Processing message {i}: role={msg['role']}, content_length={len(msg.get('content', ''))}, has_content={bool(msg.get('content', '').strip())}")
            
            # Skip messages that have no content and are not the last message with an image
            if not msg.get('content') or not msg['content'].strip():
                # Check if this is the last message and we have an image
                if i == len(messages) - 1 and image_data:
                    print(f"Message {i}: Last message with image, keeping despite empty content")
                    # Continue processing this message
                else:
                    print(f"Message {i}: Skipping empty message (no content, not last with image)")
                    continue
            
            # If this is the last message and we have an image, combine them
            if i == len(messages) - 1 and image_data:
                print(f"Message {i}: Processing last message with image")
                message_content = [
                    {
                        'type': 'image',
                        'source': {
                            'type': 'base64',
                            'media_type': image_data['media_type'],
                            'data': image_data['data']
                        }
                    }
                ]
                # Only add text content if it's not empty
                if msg['content'] and msg['content'].strip():
                    print(f"Message {i}: Adding text content with image")
                    message_content.append({
                        'type': 'text',
                        'text': msg['content']
                    })
                else:
                    print(f"Message {i}: Image-only message (no text content)")
                    
                all_messages.append({
                    'role': msg['role'],
                    'content': message_content
                })
            else:
                # Regular text message
                print(f"Message {i}: Processing regular text message")
                content_block = {
                    'type': 'text',
                    'text': msg['content']
                }
                
                # Add caching to assistant messages if enabled, content is not empty, and it's one of the selected messages
                if use_cache and msg['role'] == 'assistant' and i in cached_assistant_indices:
                    if msg['content'].strip():  # Only add cache control if content is not empty
                        print(f"Message {i}: Adding cache control to assistant message (one of last {max_cached_assistant_messages})")
                        content_block['cache_control'] = {'type': 'ephemeral'}
                    else:
                        print(f"Message {i}: Skipping cache control for empty assistant message")
                elif msg['role'] == 'assistant' and i not in cached_assistant_indices and use_cache:
                    print(f"Message {i}: Assistant message not selected for caching (keeping only last {max_cached_assistant_messages})")
                
                message = {
                    'role': msg['role'],
                    'content': [content_block]
                }
                all_messages.append(message)
        
        print(f"Total messages after processing: {len(all_messages)}")
        print(f"Total cache blocks used: 1 (system) + {len(cached_assistant_indices)} (assistant messages) = {1 + len(cached_assistant_indices)}")
        
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
            print(f"Adding system prompt, length={len(system_prompt)}, use_cache={use_cache}")
            system_content = {
                'type': 'text',
                'text': system_prompt
            }
            if use_cache and system_prompt.strip():  # Only add cache control if content is not empty
                print("Adding cache control to system prompt")
                system_content['cache_control'] = {'type': 'ephemeral'}
            elif use_cache and not system_prompt.strip():
                print("Warning: System prompt is empty, skipping cache control")
            message_options['system'] = [system_content]
        
        # Create a generator for streaming response
        def generate():
            full_response = ''
            thinking_content = ''
            is_thinking = False
            
            try:
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
                                        # Stream text chunks as SSE
                                        yield f"data: {json.dumps({'type': 'chunk', 'text': text})}\n\n"
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
                    
                    # Send final message with complete data
                    yield f"data: {json.dumps({'type': 'done', 'content': full_response, 'thinking': thinking_content if thinking_content else None, 'usage': usage, 'cached': 'cache_read_tokens' in usage})}\n\n"
                    
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
        
        # Return streaming response with proper headers
        from flask import Response
        return Response(generate(), mimetype='text/event-stream', headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no'  # Disable buffering for nginx
        })
        
    except Exception as e:
        print(f"Error in chat function: {str(e)}")
        return {'error': str(e)}, 500
