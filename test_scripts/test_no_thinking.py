#!/usr/bin/env python3
"""
@file test_no_thinking.py
@brief Test script for Claude API with thinking mode DISABLED.

@details This script tests the Claude Sonnet 4.5 API via Anthropic Vertex
without thinking mode enabled. It runs an automated conversation with
predefined prompts and displays full responses in the terminal.

@author cloud-claude test suite
@date 2024-12-30
"""

from anthropic import AnthropicVertex
import sys

# Configuration - matching the backend
LOCATION = "global"
PROJECT_ID = "wz-cloud-claude"
MODEL = "claude-opus-4-6"
MAX_TOKENS = 8192

# Predefined conversation
CONVERSATION_PROMPTS = [
    "For the following phrases give me just the Mandarin and authentic colloquial Cantonese equivalent, no explanations, with their pinyin and jyutping respectively",
    "I will put on the brakes and stop the car",
    "Let me set a timer"
]


def run_conversation():
    """
    @brief Run the automated test conversation with thinking mode DISABLED.
    
    @details Initializes the Anthropic Vertex client and runs through
    predefined prompts, maintaining conversation history and streaming
    responses to the terminal.
    """
    print("=" * 60)
    print("CLAUDE TEST - THINKING MODE DISABLED")
    print(f"Model: {MODEL}")
    print(f"Region: {LOCATION}")
    print(f"Project: {PROJECT_ID}")
    print("=" * 60)
    print()
    
    # Initialize client
    client = AnthropicVertex(region=LOCATION, project_id=PROJECT_ID)
    
    # Maintain conversation history
    messages = []
    
    for i, prompt in enumerate(CONVERSATION_PROMPTS, 1):
        print(f"\n{'=' * 60}")
        print(f"TURN {i}")
        print("=" * 60)
        print(f"\n[USER]: {prompt}\n")
        
        # Add user message to history
        messages.append({
            "role": "user",
            "content": prompt
        })
        
        # Make API call WITHOUT thinking mode
        print("[CLAUDE]: ", end="", flush=True)
        
        full_response = ""
        
        try:
            with client.messages.stream(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                messages=messages
                # NOTE: No 'thinking' parameter - thinking mode is DISABLED
            ) as stream:
                for text in stream.text_stream:
                    print(text, end="", flush=True)
                    full_response += text
                
                # Get final message for usage stats
                final_message = stream.get_final_message()
                
            print("\n")  # New line after response
            
            # Add assistant response to history
            messages.append({
                "role": "assistant",
                "content": full_response
            })
            
            # Print usage stats
            print("-" * 40)
            print(f"Input tokens: {final_message.usage.input_tokens}")
            print(f"Output tokens: {final_message.usage.output_tokens}")
            
            # Check for cache stats
            if hasattr(final_message.usage, 'cache_creation_input_tokens'):
                print(f"Cache creation tokens: {final_message.usage.cache_creation_input_tokens}")
            if hasattr(final_message.usage, 'cache_read_input_tokens'):
                print(f"Cache read tokens: {final_message.usage.cache_read_input_tokens}")
            
        except Exception as e:
            print(f"\n\nERROR: {str(e)}")
            sys.exit(1)
    
    # Continue with interactive prompts
    print("\n" + "=" * 60)
    print("ENTERING INTERACTIVE MODE - Type 'quit' or 'exit' to end")
    print("=" * 60)
    
    while True:
        try:
            print()
            user_input = input("[YOUR PROMPT]: ").strip()
            
            if not user_input:
                continue
            
            if user_input.lower() in ['quit', 'exit', 'q']:
                print("\nExiting...")
                break
            
            # Add user message to history
            messages.append({
                "role": "user",
                "content": user_input
            })
            
            print("\n[CLAUDE]: ", end="", flush=True)
            
            full_response = ""
            
            try:
                with client.messages.stream(
                    model=MODEL,
                    max_tokens=MAX_TOKENS,
                    messages=messages
                ) as stream:
                    for text in stream.text_stream:
                        print(text, end="", flush=True)
                        full_response += text
                    
                    final_message = stream.get_final_message()
                    
                print("\n")
                
                # Add assistant response to history
                messages.append({
                    "role": "assistant",
                    "content": full_response
                })
                
                # Print usage stats
                print("-" * 40)
                print(f"Input tokens: {final_message.usage.input_tokens}")
                print(f"Output tokens: {final_message.usage.output_tokens}")
                
                if hasattr(final_message.usage, 'cache_creation_input_tokens'):
                    print(f"Cache creation tokens: {final_message.usage.cache_creation_input_tokens}")
                if hasattr(final_message.usage, 'cache_read_input_tokens'):
                    print(f"Cache read tokens: {final_message.usage.cache_read_input_tokens}")
                    
            except Exception as e:
                print(f"\n\nERROR: {str(e)}")
                # Remove failed message from history
                messages.pop()
                
        except KeyboardInterrupt:
            print("\n\nInterrupted. Exiting...")
            break
    
    print("\n" + "=" * 60)
    print("CONVERSATION COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    run_conversation()
