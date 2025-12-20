import functions_framework
from flask_cors import cross_origin
import json
import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime
import asyncio
from concurrent.futures import ThreadPoolExecutor

# Initialize Firebase Admin
if not firebase_admin._apps:
    firebase_admin.initialize_app()

db = firestore.client()

@functions_framework.http
@cross_origin()
def search_messages(request):
    """
    Optimized Cloud Function to search messages across a user's chats.
    
    Expects JSON payload with:
    - userId: The user ID to search messages for
    - query: The search query string
    - limit: (optional) Maximum number of results (default: 50)
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
        
        if not request_json:
            return {'error': 'Invalid request body'}, 400
            
        user_id = request_json.get('userId')
        search_query = request_json.get('query')
        limit = request_json.get('limit', 50)
        
        if not user_id or not search_query:
            return {'error': 'userId and query are required'}, 400
        
        # Convert search query to lowercase for case-insensitive search
        query_lower = search_query.lower()
        
        results = []
        
        # Get all chats for the user in a single batch
        chats_ref = db.collection('chats').document(user_id).collection('conversations')
        chats_snapshot = chats_ref.get()
        
        # Build a map of chatId -> chat data for quick lookup
        chat_map = {}
        chat_ids = []
        for chat_doc in chats_snapshot:
            chat_data = chat_doc.to_dict()
            chat_map[chat_doc.id] = {
                'id': chat_doc.id,
                'title': chat_data.get('title', 'Untitled Chat')
            }
            chat_ids.append(chat_doc.id)
        
        # If user has no chats, return empty results
        if not chat_ids:
            return {
                'results': [],
                'count': 0,
                'query': search_query
            }
        
        # Process chats in parallel for better performance
        def search_chat_messages(chat_id):
            """Search messages in a single chat"""
            chat_results = []
            try:
                # Get messages ordered by timestamp descending (most recent first)
                messages_ref = chats_ref.document(chat_id).collection('messages')
                messages_query = messages_ref.order_by('timestamp', direction=firestore.Query.DESCENDING).limit(100)
                messages = messages_query.stream()
                
                for msg_doc in messages:
                    # Early termination if we already have enough results globally
                    if len(results) >= limit:
                        break
                        
                    msg_data = msg_doc.to_dict()
                    content = msg_data.get('content', '')
                    
                    # Case-insensitive search
                    if content and query_lower in content.lower():
                        # Convert Firestore timestamp to serializable format
                        timestamp = msg_data.get('timestamp')
                        if timestamp:
                            # Convert to ISO format string
                            timestamp_str = timestamp.isoformat() if hasattr(timestamp, 'isoformat') else str(timestamp)
                        else:
                            timestamp_str = None
                        
                        chat_results.append({
                            'chatId': chat_id,
                            'chatTitle': chat_map[chat_id]['title'],
                            'messageId': msg_doc.id,
                            'content': content,
                            'role': msg_data.get('role', 'user'),
                            'timestamp': timestamp_str
                        })
                        
                        # Early termination for this chat if we found enough
                        if len(chat_results) >= 5:  # Limit results per chat
                            break
            except Exception as e:
                print(f"Error searching chat {chat_id}: {str(e)}")
            
            return chat_results
        
        # Use ThreadPoolExecutor for parallel processing
        with ThreadPoolExecutor(max_workers=10) as executor:
            # Submit all chat searches in parallel
            future_to_chat = {executor.submit(search_chat_messages, chat_id): chat_id 
                             for chat_id in chat_ids}
            
            # Collect results as they complete
            for future in future_to_chat:
                try:
                    chat_results = future.result(timeout=5)  # 5 second timeout per chat
                    results.extend(chat_results)
                    
                    # Stop processing if we have enough results
                    if len(results) >= limit:
                        break
                except Exception as e:
                    chat_id = future_to_chat[future]
                    print(f"Error processing chat {chat_id}: {str(e)}")
        
        # Trim to limit and sort by timestamp (most recent first)
        results = results[:limit]
        results.sort(key=lambda x: x['timestamp'] or '', reverse=True)
        
        return {
            'results': results,
            'count': len(results),
            'query': search_query
        }
        
    except Exception as e:
        print(f"Error in search function: {str(e)}")
        return {'error': str(e)}, 500
