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
LOCATION = "global"
PROJECT_ID = "wz-cloud-claude"
MODEL_DEFAULT = "claude-opus-4-7"
MODEL_FAST = "claude-sonnet-4-6"

client = AnthropicVertex(region=LOCATION, project_id=PROJECT_ID)

def download_file_from_storage(url):
    """Download file (image or PDF) from Firebase Storage using Admin SDK."""
    try:
        parsed_url = urlparse(url)

        if 'firebasestorage.googleapis.com' in parsed_url.netloc:
            path_parts = parsed_url.path.split('/o/')
            if len(path_parts) > 1:
                file_path = unquote(path_parts[1].split('?')[0])
                bucket = storage.bucket('wz-cloud-claude.firebasestorage.app')
                blob = bucket.blob(file_path)
                content = blob.download_as_bytes()
                content_type = blob.content_type or 'image/jpeg'
                base64_data = base64.b64encode(content).decode('utf-8')
                return base64_data, content_type

        raise ValueError("Invalid Firebase Storage URL")

    except Exception as e:
        print(f"Error downloading file from Firebase Storage: {str(e)}")
        raise

@functions_framework.http
@cross_origin()
def chat(request):
    """
    Cloud Function to handle all chat scenarios with Claude.

    Expects JSON payload with:
    - messages: Array of message objects with 'role' and 'content'
    - image: (optional) Object with 'data' (base64) and 'media_type'
    - document: (optional) Object with 'url' or 'data' for PDF files
    - system_prompt: (optional) System prompt for context
    - use_cache: (optional) Boolean to enable prompt caching (default: True)
    - max_tokens: (optional) Maximum tokens for response (default: 8192)
    - disable_thinking: (optional) Boolean to disable thinking mode
    - use_fast_model: (optional) Boolean to use Sonnet instead of Opus
    - enable_web_search: (optional) Boolean to enable web search tool
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
        document_data = request_json.get('document')
        system_prompt = request_json.get('system_prompt')
        use_cache = request_json.get('use_cache', True)
        max_tokens = request_json.get('max_tokens', 8192)
        disable_thinking = request_json.get('disable_thinking', False)
        use_fast_model = request_json.get('use_fast_model', False)
        enable_web_search = request_json.get('enable_web_search', False)

        # Select model
        model = MODEL_FAST if use_fast_model else MODEL_DEFAULT
        print(f"Request config: model={model}, disable_thinking={disable_thinking}, use_cache={use_cache}, max_tokens={max_tokens}, web_search={enable_web_search}")
        print(f"Full request payload keys: {list(request_json.keys())}")

        # Handle image data - convert URL to base64 if needed
        if image_data:
            if 'url' in image_data and image_data['url'].startswith('http'):
                base64_data, content_type = download_file_from_storage(image_data['url'])
                image_data = {'data': base64_data, 'media_type': content_type}
            elif 'url' in image_data and image_data['url'].startswith('data:'):
                base64_data = image_data['url'].split(',')[1]
                media_type = image_data.get('type', 'image/jpeg')
                image_data = {'data': base64_data, 'media_type': media_type}

        # Handle document (PDF) data - convert URL to base64 if needed
        if document_data:
            if 'url' in document_data and document_data['url'].startswith('http'):
                base64_data, content_type = download_file_from_storage(document_data['url'])
                document_data = {'data': base64_data, 'media_type': content_type}
            elif 'url' in document_data and document_data['url'].startswith('data:'):
                base64_data = document_data['url'].split(',')[1]
                document_data = {'data': base64_data, 'media_type': 'application/pdf'}
            print(f"Document attached: media_type={document_data.get('media_type')}, data_length={len(document_data.get('data', ''))}")

        # Prepare messages (excluding system prompt)
        all_messages = []

        # First pass: collect assistant message indices with content
        assistant_indices = []
        for i, msg in enumerate(messages):
            if msg['role'] == 'assistant' and msg.get('content', '').strip():
                assistant_indices.append(i)

        # Cache last 2 assistant messages (max 4 cache blocks total: 1 system + 2 assistant + 1 spare)
        max_cached_assistant_messages = 2
        cached_assistant_indices = set(assistant_indices[-max_cached_assistant_messages:]) if assistant_indices else set()

        print(f"Assistant message indices: {assistant_indices}")
        print(f"Will cache assistant messages at indices: {cached_assistant_indices}")

        # Process regular messages
        has_attachment = image_data or document_data
        for i, msg in enumerate(messages):
            print(f"Processing message {i}: role={msg['role']}, content_length={len(msg.get('content', ''))}")

            # Skip empty messages unless it's the last one with an attachment
            if not msg.get('content') or not msg['content'].strip():
                if i == len(messages) - 1 and has_attachment:
                    pass  # Keep this message for attachment
                else:
                    continue

            # If this is the last message and we have attachments, combine them
            if i == len(messages) - 1 and has_attachment:
                message_content = []

                # Add image if present
                if image_data:
                    message_content.append({
                        'type': 'image',
                        'source': {
                            'type': 'base64',
                            'media_type': image_data['media_type'],
                            'data': image_data['data']
                        }
                    })

                # Add document (PDF) if present
                if document_data:
                    message_content.append({
                        'type': 'document',
                        'source': {
                            'type': 'base64',
                            'media_type': document_data['media_type'],
                            'data': document_data['data']
                        }
                    })

                # Add text content if not empty
                if msg.get('content') and msg['content'].strip():
                    message_content.append({
                        'type': 'text',
                        'text': msg['content']
                    })

                all_messages.append({
                    'role': msg['role'],
                    'content': message_content
                })
            else:
                # Regular text message
                content_block = {
                    'type': 'text',
                    'text': msg['content']
                }

                # Add caching to selected assistant messages
                if use_cache and msg['role'] == 'assistant' and i in cached_assistant_indices:
                    if msg['content'].strip():
                        content_block['cache_control'] = {'type': 'ephemeral'}

                all_messages.append({
                    'role': msg['role'],
                    'content': [content_block]
                })

        print(f"Total messages after processing: {len(all_messages)}")

        # Prepare the message options
        message_options = {
            'max_tokens': max_tokens,
            'messages': all_messages,
            'model': model,
        }

        # Add thinking mode unless disabled
        if disable_thinking:
            print("Thinking mode DISABLED for this request")
        else:
            # budget_tokens must be < max_tokens
            thinking_budget = min(10000, max_tokens - 1)
            print(f"Thinking mode ENABLED with {thinking_budget} token budget, model={model}")
            message_options['thinking'] = {
                'type': 'enabled',
                'budget_tokens': thinking_budget
            }

        # Add web search tool if enabled
        if enable_web_search:
            print("Web search ENABLED")
            message_options['tools'] = [{
                'type': 'web_search_20250305',
                'name': 'web_search',
                'max_uses': 5
            }]

        # Add system prompt as top-level parameter if provided
        if system_prompt:
            print(f"Adding system prompt, length={len(system_prompt)}, use_cache={use_cache}")
            system_content = {
                'type': 'text',
                'text': system_prompt
            }
            if use_cache and system_prompt.strip():
                system_content['cache_control'] = {'type': 'ephemeral'}
            message_options['system'] = [system_content]

        # Create a generator for streaming response
        def generate():
            full_response = ''
            thinking_content = ''
            is_thinking = False
            citations = []
            web_search_queries = []
            current_block_type = None

            try:
                with client.messages.stream(**message_options) as stream:
                    for event in stream:
                        if not hasattr(event, 'type'):
                            continue

                        if event.type == 'content_block_start':
                            if hasattr(event, 'content_block'):
                                current_block_type = event.content_block.type
                                if current_block_type == 'thinking':
                                    is_thinking = True
                                elif current_block_type == 'server_tool_use':
                                    # Log the search query
                                    if hasattr(event.content_block, 'name'):
                                        print(f"Web search tool invoked: {event.content_block.name}")
                                elif current_block_type == 'web_search_tool_result':
                                    # Search results received
                                    if hasattr(event.content_block, 'content') and event.content_block.content:
                                        result_count = len(event.content_block.content)
                                        print(f"Web search returned {result_count} results")

                        elif event.type == 'content_block_delta':
                            if hasattr(event, 'delta'):
                                if hasattr(event.delta, 'text'):
                                    text = event.delta.text
                                    if is_thinking:
                                        thinking_content += text
                                    else:
                                        full_response += text
                                        yield f"data: {json.dumps({'type': 'chunk', 'text': text})}\n\n"
                                elif hasattr(event.delta, 'partial_json'):
                                    # This is the search query being built
                                    pass

                        elif event.type == 'content_block_stop':
                            if is_thinking:
                                is_thinking = False
                            current_block_type = None

                    # Extract citations from the final message snapshot
                    final_message = stream.current_message_snapshot
                    for block in final_message.content:
                        if block.type == 'text' and hasattr(block, 'citations') and block.citations:
                            for citation in block.citations:
                                if hasattr(citation, 'url'):
                                    citations.append({
                                        'url': citation.url,
                                        'title': getattr(citation, 'title', ''),
                                        'cited_text': getattr(citation, 'cited_text', '')[:200]
                                    })
                        elif block.type == 'server_tool_use' and hasattr(block, 'input'):
                            query = block.input.get('query', '') if isinstance(block.input, dict) else ''
                            if query:
                                web_search_queries.append(query)

                    # Get usage stats
                    usage = {
                        'input_tokens': final_message.usage.input_tokens,
                        'output_tokens': final_message.usage.output_tokens
                    }

                    if hasattr(final_message.usage, 'cache_creation_input_tokens'):
                        usage['cache_creation_tokens'] = final_message.usage.cache_creation_input_tokens
                    if hasattr(final_message.usage, 'cache_read_input_tokens'):
                        usage['cache_read_tokens'] = final_message.usage.cache_read_input_tokens
                    if hasattr(final_message.usage, 'server_tool_use') and final_message.usage.server_tool_use:
                        if hasattr(final_message.usage.server_tool_use, 'web_search_requests'):
                            usage['web_search_requests'] = final_message.usage.server_tool_use.web_search_requests

                    # Deduplicate citations by URL
                    seen_urls = set()
                    unique_citations = []
                    for c in citations:
                        if c['url'] not in seen_urls:
                            seen_urls.add(c['url'])
                            unique_citations.append(c)

                    # Build done payload
                    done_payload = {
                        'type': 'done',
                        'content': full_response,
                        'thinking': thinking_content if thinking_content else None,
                        'usage': usage,
                        'cached': 'cache_read_tokens' in usage,
                        'model': model
                    }

                    if unique_citations:
                        done_payload['citations'] = unique_citations
                        print(f"Citations found: {len(unique_citations)}")
                    if web_search_queries:
                        done_payload['web_search_queries'] = web_search_queries
                        print(f"Search queries used: {web_search_queries}")

                    print(f"Usage: {json.dumps(usage)}")
                    yield f"data: {json.dumps(done_payload)}\n\n"

            except Exception as e:
                print(f"Streaming error: {str(e)}")
                yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"

        # Return streaming response with proper headers
        from flask import Response
        return Response(generate(), mimetype='text/event-stream', headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no'
        })

    except Exception as e:
        print(f"Error in chat function: {str(e)}")
        return {'error': str(e)}, 500
