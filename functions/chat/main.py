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

# Max output tokens per model (Opus supports up to 128K, Sonnet stays at 8K for speed)
MAX_TOKENS_OPUS = 128000
MAX_TOKENS_SONNET = 8192

client = AnthropicVertex(region=LOCATION, project_id=PROJECT_ID)

# System prompt for wrap_content mode — converts Chinese+phonetic text to
# HTML wrappers (<span class="zh-yue"> for Cantonese, <ruby><rt> for Mandarin).
# Also imported by test_scripts/wrap_chinese_messages.py for backfill.
WRAP_PROMPT = """You convert assistant chat messages into HTML-wrapped \
markdown that visually renders Chinese with phonetic annotations. Apply the \
rules below mechanically. Output ONLY the transformed message text — no \
commentary, no code fences around the output.

RULES

1. CANTONESE — wrap the Chinese-character LINE in <span class="zh-yue">…</span>.
   Leave the jyutping line that follows it OUTSIDE the span (it stays as plain
   text below the span as a fallback when the Visual Fonts font is not loaded).
   A "Cantonese run" is Chinese characters whose accompanying romanization is
   jyutping — ASCII letters ending in tone digits 1-6 (e.g. "nei5 hou2",
   "cung4 cin4 hai2 jat1 go3 hou2 jyun5"). A Chinese run with no romanization
   counts as Cantonese only if it contains at least one HK-distinctive
   character: 嘅 喺 哋 佢 啲 咗 嚟 嘢 㗎 咩 嗰 噉 諗 唔 係 冇 俾.

   Wrap the WHOLE Cantonese sentence/clause/line in a single <span class="zh-yue">,
   not individual sub-spans. If a sentence has bold or italic markdown inside
   it, the span wraps the whole sentence and the bold/italic stays nested:
     "園戶嘅比喻揭示咗**人完全嘅墮落**。" →
     "<span class=\\"zh-yue\\">園戶嘅比喻揭示咗**人完全嘅墮落**。</span>"
   NOT: "園戶嘅比喻揭示咗<span class=\\"zh-yue\\">**人完全嘅墮落**</span>。"

2. MANDARIN — convert the Chinese-character text to inline <ruby> tags, one
   <rt> per base character: 你好 → <ruby>你<rt>nǐ</rt>好<rt>hǎo</rt></ruby>.
   The standalone pinyin line that was the source MUST be deleted (do not
   duplicate). A "Mandarin run" is Chinese characters whose accompanying
   romanization uses tone-mark diacritics: āáǎà ēéěè īíǐì ōóǒò ūúǔù ǖǘǚǜ
   (e.g. "nǐ hǎo", "xiāng fǎn cí"). Punctuation gets <rt></rt>. If syllable
   count differs from character count, do best alignment and pad with empty
   <rt></rt> for unmatched chars.

   CRITICAL: NEVER invent pinyin. The pinyin tones MUST come from the source
   text adjacent to the Chinese characters. If a Chinese run has no nearby
   pinyin (e.g. characters appear in a table cell or inline parenthetical
   without diacritic romanization next to them), DO NOT add ruby tags — leave
   the characters bare. Generating pinyin from your own knowledge violates
   this rule.

   Japanese romanization uses some of the same diacritics (ō, ū). If the
   surrounding context is Japanese (kana mixed in, Japanese place names,
   "no" particle, etc.), it is NOT pinyin — leave it alone.

3. INTERLEAVED CHAR-PINYIN FORMAT: when each Chinese character is immediately
   followed by its pinyin/jyutping with no separator (e.g. 鸟niǎo儿ér飞fēi上shàng
   or 春ceon1天tin1), split each char-reading pair into ruby or span:
     Mandarin: 鸟niǎo儿ér飞fēi → <ruby>鸟<rt>niǎo</rt>儿<rt>ér</rt>飞<rt>fēi</rt></ruby>
     Cantonese: 春ceon1天tin1 → <span class="zh-yue">春ceon1天tin1</span>
   Detection: a CJK character immediately followed by a Latin+diacritic syllable
   (Mandarin) or a Latin+digit syllable (Cantonese), repeating for multiple chars.
   Punctuation between chars (，。！) keeps its position with an empty <rt></rt>.

4. INLINE PARENTHESIZED FORMS:
     **驚青** (geng1 ceng1)   →   **<span class="zh-yue">驚青</span>** (geng1 ceng1)
     **你好** (nǐ hǎo)        →   **<ruby>你<rt>nǐ</rt>好<rt>hǎo</rt></ruby>**
   For inline Mandarin, the "(nǐ hǎo)" parenthetical is consumed into the
   ruby and removed. For inline Cantonese, keep "(geng1 ceng1)" OUTSIDE the
   span so it renders at normal text size (the span inherits a large
   font-size for Visual Fonts, and ASCII jyutping inside it would be huge).

5. SECTION HEADERS like "**Mandarin:**" and "**Cantonese:**" stay OUTSIDE any
   wrapper. Only the content lines after them go inside.

6. PRESERVE EVERYTHING ELSE byte-for-byte: bullets, code fences, headers,
   English text, blank lines, Markdown emphasis. Do NOT translate, summarize,
   re-order, or rewrite any text.

7. NO PHONETIC-COUPLED CHINESE → return the input unchanged.

EXAMPLES

[Example 1 — stacked dual-line Cantonese]
INPUT:
從前，喺一個好遠嘅國度裏面
cung4 cin4, hai2 jat1 go3 hou2 jyun5 ge3 gwok3 dou6 leoi5 min6

有一位國王同埋王后。
jau5 jat1 wai2 gwok3 wong4 tung4 maai4 wong4 hau6
OUTPUT:
<span class="zh-yue">從前，喺一個好遠嘅國度裏面</span>
cung4 cin4, hai2 jat1 go3 hou2 jyun5 ge3 gwok3 dou6 leoi5 min6

<span class="zh-yue">有一位國王同埋王后。</span>
jau5 jat1 wai2 gwok3 wong4 tung4 maai4 wong4 hau6

[Example 2 — sectioned Mandarin + Cantonese]
INPUT:
**Mandarin:**
你好你好，相反词
nǐ hǎo nǐ hǎo, xiāng fǎn cí

**Cantonese:**
哈囉哈囉，相反嘅嘢
haa1 lo1 haa1 lo1, soeng1 faan2 ge3 je5
OUTPUT:
**Mandarin:**
<ruby>你<rt>nǐ</rt>好<rt>hǎo</rt>你<rt>nǐ</rt>好<rt>hǎo</rt>，<rt></rt>相<rt>xiāng</rt>反<rt>fǎn</rt>词<rt>cí</rt></ruby>

**Cantonese:**
<span class="zh-yue">哈囉哈囉，相反嘅嘢</span>
haa1 lo1 haa1 lo1, soeng1 faan2 ge3 je5

[Example 3 — inline parenthesized vocabulary breakdown]
INPUT:
- **你哋** (nei5 dei6) = you all, you guys (plural "you")
- **個** (go3) = classifier/possessive marker
- **驚青** (geng1 ceng1) — scaredy-cat
OUTPUT:
- **<span class="zh-yue">你哋</span>** (nei5 dei6) = you all, you guys (plural "you")
- **<span class="zh-yue">個</span>** (go3) = classifier/possessive marker
- **<span class="zh-yue">驚青</span>** (geng1 ceng1) — scaredy-cat

[Example 4 — Cantonese with HK-distinctive chars, no romanization]
INPUT:
This sentence is in **Cantonese** because of 嘅, 喺, 哋. The pattern means...
OUTPUT:
This sentence is in **Cantonese** because of <span class="zh-yue">嘅, 喺, 哋</span>. The pattern means...

[Example 5 — interleaved char-pinyin Mandarin]
INPUT:
Mandarin: 鸟niǎo儿ér飞fēi上shàng，鸟niǎo儿ér飞fēi下xià
OUTPUT:
Mandarin: <ruby>鸟<rt>niǎo</rt>儿<rt>ér</rt>飞<rt>fēi</rt>上<rt>shàng</rt>，<rt></rt>鸟<rt>niǎo</rt>儿<rt>ér</rt>飞<rt>fēi</rt>下<rt>xià</rt></ruby>

[Example 6 — no Chinese, unchanged]
INPUT:
Here's a Shakespeare soliloquy about computing.
OUTPUT:
Here's a Shakespeare soliloquy about computing.
"""


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

        # --- wrap_content mode: convert Chinese text to ruby/span markup ---
        if request_json and 'wrap_content' in request_json:
            content = request_json['wrap_content']
            if not isinstance(content, str) or not content.strip():
                return {'wrapped': content or ''}, 200
            use_fast = bool(request_json.get('use_fast_model', True))
            model = MODEL_FAST if use_fast else MODEL_DEFAULT
            print(f"wrap_content mode: model={model} content_len={len(content)}")
            resp = client.messages.create(
                model=model,
                max_tokens=MAX_TOKENS_SONNET,
                system=WRAP_PROMPT,
                messages=[{"role": "user", "content": content}],
            )
            wrapped = "".join(
                b.text for b in resp.content if getattr(b, "type", None) == "text"
            )
            print(f"wrap_content done: wrapped_len={len(wrapped)} in={resp.usage.input_tokens} out={resp.usage.output_tokens}")
            return {'wrapped': wrapped, 'model': model}, 200

        if not request_json or 'messages' not in request_json:
            return {'error': 'Messages are required'}, 400

        messages = request_json.get('messages', [])
        image_data = request_json.get('image')
        document_data = request_json.get('document')
        system_prompt = request_json.get('system_prompt')
        use_cache = request_json.get('use_cache', True)
        disable_thinking = request_json.get('disable_thinking', False)
        use_fast_model = request_json.get('use_fast_model', False)
        enable_web_search = request_json.get('enable_web_search', False)

        # Select model and set per-model max output tokens
        model = MODEL_FAST if use_fast_model else MODEL_DEFAULT
        max_tokens = MAX_TOKENS_SONNET if use_fast_model else MAX_TOKENS_OPUS
        print(f"Request config: model={model}, disable_thinking={disable_thinking}, use_cache={use_cache}, max_tokens={max_tokens}, web_search={enable_web_search}")
        print(f"Full request payload keys: {list(request_json.keys())}")

        # Per-request cache so the same Storage URL isn't downloaded twice
        # (relevant when an image appears in history AND in the current turn,
        # or when the same image is referenced across multiple historical turns).
        download_cache = {}

        def fetch_attachment(url, fallback_media_type='image/jpeg'):
            """Resolve a Storage URL or data: URL to (base64_data, media_type), cached per-request."""
            if url in download_cache:
                return download_cache[url]
            if url.startswith('http'):
                b64, mime = download_file_from_storage(url)
            elif url.startswith('data:'):
                b64 = url.split(',', 1)[1]
                mime_part = url.split(',', 1)[0]
                mime = mime_part.split(';')[0].split(':', 1)[1] if ':' in mime_part else fallback_media_type
            else:
                raise ValueError(f"Unsupported attachment URL prefix: {url[:60]}")
            download_cache[url] = (b64, mime)
            print(f"  fetch_attachment: url={url[:80]}... mime={mime}, b64_len={len(b64)}")
            return download_cache[url]

        # Resolve current-turn (top-level) image to {data, media_type}
        if image_data:
            if 'url' in image_data:
                b64, mime = fetch_attachment(image_data['url'], image_data.get('type', 'image/jpeg'))
                image_data = {'data': b64, 'media_type': mime}
                print(f"Current-turn image: media_type={mime}, data_length={len(b64)}")

        # Resolve current-turn (top-level) document to {data, media_type}
        if document_data:
            if 'url' in document_data:
                b64, mime = fetch_attachment(document_data['url'], 'application/pdf')
                document_data = {'data': b64, 'media_type': mime}
                print(f"Current-turn document: media_type={mime}, data_length={len(b64)}")

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

        # Find the latest HISTORICAL message that has an image attached.
        # We'll mark its image block with cache_control so the heavy base64
        # payload stays in Anthropic's prompt cache across follow-up turns.
        # (Current-turn image is fresh; we don't cache it since the next turn
        # will move it into history and re-mark it then.)
        latest_historical_image_idx = -1
        for i, msg in enumerate(messages[:-1]):
            if msg.get('image') and msg['image'].get('url'):
                latest_historical_image_idx = i
        if latest_historical_image_idx >= 0:
            print(f"Latest historical image at index {latest_historical_image_idx} - will mark with cache_control")

        # Process all messages. Each message may carry its own image/document
        # via msg.image / msg.document (Storage URL refs). The current/last
        # turn pulls its attachment from the top-level image_data/document_data
        # set above.
        last_idx = len(messages) - 1
        for i, msg in enumerate(messages):
            is_last = (i == last_idx)
            text_content = msg.get('content') or ''

            # Determine attachments for THIS message
            msg_image = None
            msg_document = None
            if is_last:
                # Top-level current-turn attachments
                msg_image = image_data
                msg_document = document_data
            else:
                # Historical message — download per-message refs from Storage
                if msg.get('image') and msg['image'].get('url'):
                    b64, mime = fetch_attachment(msg['image']['url'], msg['image'].get('type', 'image/jpeg'))
                    msg_image = {'data': b64, 'media_type': mime}
                    print(f"  Historical image at msg {i}: mime={mime}, b64_len={len(b64)}")
                if msg.get('document') and msg['document'].get('url'):
                    b64, mime = fetch_attachment(msg['document']['url'], 'application/pdf')
                    msg_document = {'data': b64, 'media_type': mime}
                    print(f"  Historical document at msg {i}: mime={mime}, b64_len={len(b64)}")

            has_msg_attachment = msg_image or msg_document
            print(f"Processing message {i}: role={msg['role']}, content_length={len(text_content)}, has_attachment={bool(has_msg_attachment)}")

            # Skip messages that have neither text nor attachment
            if not text_content.strip() and not has_msg_attachment:
                continue

            if has_msg_attachment:
                message_content = []

                if msg_image:
                    img_block = {
                        'type': 'image',
                        'source': {
                            'type': 'base64',
                            'media_type': msg_image['media_type'],
                            'data': msg_image['data']
                        }
                    }
                    # Cache the latest historical image so subsequent turns
                    # don't re-pay tokens for the same base64 payload.
                    if use_cache and i == latest_historical_image_idx:
                        img_block['cache_control'] = {'type': 'ephemeral'}
                        print(f"  Added cache_control to image block at msg {i}")
                    message_content.append(img_block)

                if msg_document:
                    message_content.append({
                        'type': 'document',
                        'source': {
                            'type': 'base64',
                            'media_type': msg_document['media_type'],
                            'data': msg_document['data']
                        }
                    })

                if text_content.strip():
                    message_content.append({
                        'type': 'text',
                        'text': text_content
                    })

                all_messages.append({
                    'role': msg['role'],
                    'content': message_content
                })
            else:
                # Text-only message
                content_block = {
                    'type': 'text',
                    'text': text_content
                }

                # Cache selected assistant messages (existing behavior)
                if use_cache and msg['role'] == 'assistant' and i in cached_assistant_indices:
                    if text_content.strip():
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

        # Add thinking mode unless disabled.
        # Opus 4.7 only accepts type='adaptive' (not 'enabled' with budget_tokens).
        # `display='summarized'` is required to actually capture thinking text —
        # default on Opus 4.7 is 'omitted', which silently strips it.
        # `output_config.effort='max'` is the real "use as much as needed" knob.
        if disable_thinking:
            print("Thinking mode DISABLED for this request")
        else:
            print(f"Thinking mode ENABLED (adaptive, effort=max, display=summarized), model={model}")
            message_options['thinking'] = {
                'type': 'adaptive',
                'display': 'summarized',
            }
            message_options['output_config'] = {'effort': 'max'}

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
                                # ThinkingDelta: attribute is .thinking, not .text.
                                # Opus 4.7 emits these when display='summarized'.
                                if hasattr(event.delta, 'thinking'):
                                    thinking_content += event.delta.thinking
                                elif hasattr(event.delta, 'text'):
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

                    stop_reason = getattr(final_message, 'stop_reason', None)
                    print(f"Usage: {json.dumps(usage)} stop_reason={stop_reason} text_len={len(full_response)} thinking_len={len(thinking_content)}")
                    done_payload['stop_reason'] = stop_reason

                    # Helper: run a non-thinking attempt synchronously, return (text, stop_reason).
                    # Doesn't yield chunks — callers replace done_payload.content with the result.
                    def run_attempt(opts, label):
                        text = ''
                        with client.messages.stream(**opts) as s:
                            for ev in s:
                                if (getattr(ev, 'type', None) == 'content_block_delta'
                                        and hasattr(ev, 'delta')
                                        and hasattr(ev.delta, 'text')):
                                    text += ev.delta.text
                            msg = s.current_message_snapshot
                            sr = getattr(msg, 'stop_reason', None)
                            u = {'input_tokens': msg.usage.input_tokens,
                                 'output_tokens': msg.usage.output_tokens}
                            print(f"{label} usage: {json.dumps(u)} stop_reason={sr} text_len={len(text)}")
                            return text, sr, u

                    # Refusal-aware retry chain. Per Anthropic's streaming-refusals doc,
                    # `stop_reason=refusal` means the safety classifier intervened — partial
                    # text may have been emitted but the turn is bad and must be replaced.
                    needs_retry = (stop_reason == 'refusal') or (not full_response.strip() and not disable_thinking)
                    if needs_retry:
                        # Attempt 2: same context, thinking off
                        retry_opts = dict(message_options)
                        retry_opts.pop('thinking', None)
                        retry_opts.pop('output_config', None)
                        try:
                            print(f"Refusal/empty-text detected — retry 1 (thinking off, full context)")
                            text2, stop2, usage2 = run_attempt(retry_opts, "Retry 1")
                            done_payload['retry_used'] = True
                            done_payload['retry_usage'] = usage2
                            done_payload['retry_stop_reason'] = stop2

                            if stop2 == 'refusal':
                                # Attempt 3: strip history, keep only initial setup turn(s)
                                # + current user turn. Per the doc, removing the refused
                                # turns from context is required to break the refusal loop.
                                minimal_msgs = []
                                if all_messages:
                                    # Keep msg 0 (system-prompt-equivalent setup) if it's a user text turn
                                    if all_messages[0].get('role') == 'user':
                                        minimal_msgs.append(all_messages[0])
                                    # Always include current turn (last message, the new user image)
                                    if len(all_messages) > 1:
                                        minimal_msgs.append(all_messages[-1])
                                minimal_opts = dict(retry_opts)
                                minimal_opts['messages'] = minimal_msgs
                                print(f"Retry 1 also refused — retry 2 (thinking off, minimal context: {len(minimal_msgs)} msgs)")
                                text3, stop3, usage3 = run_attempt(minimal_opts, "Retry 2")
                                done_payload['retry2_usage'] = usage3
                                done_payload['retry2_stop_reason'] = stop3

                                if stop3 == 'refusal':
                                    # Give up gracefully with a user-facing message rather
                                    # than saving an empty bubble to Firestore.
                                    full_response = ("I wasn't able to process this image. "
                                                     "It may have triggered a content filter. "
                                                     "Try uploading a different photo, or start a new chat.")
                                    done_payload['gave_up'] = True
                                else:
                                    full_response = text3
                            else:
                                full_response = text2

                            done_payload['content'] = full_response
                        except Exception as retry_err:
                            print(f"Retry chain failed: {retry_err}")
                            if not full_response.strip():
                                full_response = ("I wasn't able to get a response. Please try again.")
                                done_payload['content'] = full_response

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
