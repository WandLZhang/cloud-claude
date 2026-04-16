#!/usr/bin/env python3
"""
Test script for Claude API web search tool on Vertex AI.

Tests that the web_search_20250305 tool works with AnthropicVertex
and Claude Sonnet 4.6. Verifies search results and citations are
returned in the response.
"""

from anthropic import AnthropicVertex
import json
import sys

# Configuration
LOCATION = "global"
PROJECT_ID = "wz-cloud-claude"
MODEL = "claude-opus-4-7"
MAX_TOKENS = 8192

# Web search tool definition
WEB_SEARCH_TOOL = {
    "type": "web_search_20250305",
    "name": "web_search",
    "max_uses": 5
}


def test_web_search_basic():
    """Test basic web search with a prompt that requires current information."""
    print("=" * 60)
    print("TEST 1: Basic Web Search")
    print(f"Model: {MODEL}")
    print(f"Region: {LOCATION}")
    print(f"Project: {PROJECT_ID}")
    print("=" * 60)

    client = AnthropicVertex(region=LOCATION, project_id=PROJECT_ID)

    prompt = "What are the latest developments in AI regulation in March 2026? Give me a brief summary with sources."

    print(f"\n[USER]: {prompt}\n")
    print("[CLAUDE]: ", end="", flush=True)

    full_response = ""
    citations = []
    search_queries = []

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
            tools=[WEB_SEARCH_TOOL]
        )

        # Process response content blocks
        for block in response.content:
            if block.type == "text":
                print(block.text, end="", flush=True)
                full_response += block.text

                # Check for citations
                if hasattr(block, 'citations') and block.citations:
                    for citation in block.citations:
                        if hasattr(citation, 'url'):
                            citations.append({
                                'url': citation.url,
                                'title': getattr(citation, 'title', 'N/A'),
                                'cited_text': getattr(citation, 'cited_text', 'N/A')
                            })

            elif block.type == "server_tool_use":
                search_query = block.input.get('query', 'N/A') if hasattr(block, 'input') else 'N/A'
                search_queries.append(search_query)
                print(f"\n  [SEARCH]: {search_query}", flush=True)

            elif block.type == "web_search_tool_result":
                result_count = len(block.content) if hasattr(block, 'content') and block.content else 0
                print(f"\n  [RESULTS]: {result_count} results returned", flush=True)

        print("\n")

        # Print usage stats
        print("-" * 40)
        print(f"Input tokens: {response.usage.input_tokens}")
        print(f"Output tokens: {response.usage.output_tokens}")
        print(f"Stop reason: {response.stop_reason}")

        if hasattr(response.usage, 'server_tool_use') and response.usage.server_tool_use:
            print(f"Web search requests: {response.usage.server_tool_use.web_search_requests}")

        if hasattr(response.usage, 'cache_creation_input_tokens'):
            print(f"Cache creation tokens: {response.usage.cache_creation_input_tokens}")
        if hasattr(response.usage, 'cache_read_input_tokens'):
            print(f"Cache read tokens: {response.usage.cache_read_input_tokens}")

        # Print search queries used
        if search_queries:
            print(f"\nSearch queries used: {len(search_queries)}")
            for i, q in enumerate(search_queries, 1):
                print(f"  {i}. {q}")

        # Print citations
        if citations:
            print(f"\nCitations found: {len(citations)}")
            for i, c in enumerate(citations, 1):
                print(f"  {i}. [{c['title']}] {c['url']}")
                print(f"     Cited: {c['cited_text'][:100]}...")
        else:
            print("\nNo citations found in response.")

        # Validation
        print("\n" + "=" * 40)
        print("VALIDATION:")
        print(f"  Response received: {'PASS' if full_response else 'FAIL'}")
        print(f"  Web search used: {'PASS' if search_queries else 'FAIL'}")
        print(f"  Citations present: {'PASS' if citations else 'WARN - no citations'}")
        print("=" * 40)

        return bool(full_response and search_queries)

    except Exception as e:
        print(f"\n\nERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        return False


def test_web_search_streaming():
    """Test web search with streaming to verify SSE handling."""
    print("\n\n" + "=" * 60)
    print("TEST 2: Web Search with Streaming")
    print("=" * 60)

    client = AnthropicVertex(region=LOCATION, project_id=PROJECT_ID)

    prompt = "What is the current weather forecast for San Francisco today?"

    print(f"\n[USER]: {prompt}\n")
    print("[CLAUDE]: ", end="", flush=True)

    full_response = ""
    found_search = False
    found_results = False
    citations = []

    try:
        with client.messages.stream(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
            tools=[WEB_SEARCH_TOOL]
        ) as stream:
            for event in stream:
                if hasattr(event, 'type'):
                    if event.type == 'content_block_start':
                        if hasattr(event, 'content_block'):
                            if event.content_block.type == 'server_tool_use':
                                found_search = True
                                print("\n  [SEARCH STARTED]", flush=True)
                            elif event.content_block.type == 'web_search_tool_result':
                                found_results = True
                                print("\n  [SEARCH RESULTS RECEIVED]", flush=True)

                    elif event.type == 'content_block_delta':
                        if hasattr(event, 'delta') and hasattr(event.delta, 'text'):
                            text = event.delta.text
                            full_response += text
                            print(text, end="", flush=True)

            # Get final message for usage
            final_message = stream.current_message_snapshot

            # Extract citations from final message
            for block in final_message.content:
                if block.type == "text" and hasattr(block, 'citations') and block.citations:
                    for citation in block.citations:
                        if hasattr(citation, 'url'):
                            citations.append({
                                'url': citation.url,
                                'title': getattr(citation, 'title', 'N/A')
                            })

        print("\n")

        # Print stats
        print("-" * 40)
        print(f"Input tokens: {final_message.usage.input_tokens}")
        print(f"Output tokens: {final_message.usage.output_tokens}")
        print(f"Stop reason: {final_message.stop_reason}")

        if citations:
            print(f"\nCitations: {len(citations)}")
            for i, c in enumerate(citations, 1):
                print(f"  {i}. [{c['title']}] {c['url']}")

        # Validation
        print("\n" + "=" * 40)
        print("VALIDATION:")
        print(f"  Streaming response: {'PASS' if full_response else 'FAIL'}")
        print(f"  Search tool used: {'PASS' if found_search else 'FAIL'}")
        print(f"  Results received: {'PASS' if found_results else 'FAIL'}")
        print(f"  Citations present: {'PASS' if citations else 'WARN'}")
        print("=" * 40)

        return bool(full_response and found_search)

    except Exception as e:
        print(f"\n\nERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    print("CLAUDE WEB SEARCH TEST SUITE")
    print("=" * 60)
    print()

    results = {}

    # Test 1: Basic web search
    results['basic'] = test_web_search_basic()

    # Test 2: Streaming web search
    results['streaming'] = test_web_search_streaming()

    # Summary
    print("\n\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    for test_name, passed in results.items():
        status = "PASS" if passed else "FAIL"
        print(f"  {test_name}: {status}")

    all_passed = all(results.values())
    print(f"\nOverall: {'ALL TESTS PASSED' if all_passed else 'SOME TESTS FAILED'}")

    sys.exit(0 if all_passed else 1)
