import os
import io
import traceback
import numpy as np
from pypdf import PdfReader
from flask import Flask, request, jsonify, make_response
from flask_cors import CORS
from google import genai
from google.genai import types
import logging

logging.basicConfig(level=logging.INFO)

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

# Disable caching during development so browser always gets fresh files
@app.after_request
def add_no_cache_headers(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

# Global error handlers — ensures we ALWAYS return JSON, never HTML
@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Not found"}), 404

@app.errorhandler(405)
def method_not_allowed(e):
    return jsonify({"error": "Method not allowed"}), 405

@app.errorhandler(500)
def internal_error(e):
    logging.error(f"Unhandled 500 error: {traceback.format_exc()}")
    return jsonify({"error": "Internal server error"}), 500

@app.errorhandler(Exception)
def handle_exception(e):
    logging.error(f"Unhandled exception: {traceback.format_exc()}")
    return jsonify({"error": str(e)}), 500

# System Prompt Definition
SYSTEM_INSTRUCTION = """Role: You are a high-performance AI Research Assistant. Your primary goal is to provide real-time, cited information in a clean, conversational format.

Operational Context:

Session Isolation: Treat every "New Chat" signal as a total reset. Do not carry over context, entities, or preferences from previous sessions unless explicitly referenced by the user from their history.

History Retrieval: When a user selects a previous chat from their history, your goal is to resume that specific thread seamlessly. You should acknowledge the previous context if the user asks a follow-up question.

Response Style: Use Markdown for clarity. Use bolding for key terms and bullet points for lists. If the user asks for technical data, use LaTeX for complex formulas.

Memory Management: You act as a stateless engine; the application layer will provide the chat_history array. Your job is to synthesize that history to provide a coherent "Current Response."
"""

# Use the provided API key
API_KEY = "AIzaSyAa6pDyO_Hq82yybSUuIeYn4dM8ie5uu68"
try:
    client = genai.Client(api_key=API_KEY)
except Exception as e:
    logging.error(f"Failed to initialize GenAI client: {e}")

# Global Storage for Simple RAG vector search
PDF_CHUNKS = [] # stores dicts: {"text": str, "embedding": np.array}

def chunk_text(text, chunk_size=1000, overlap=100):
    chunks = []
    start = 0
    text_len = len(text)
    while start < text_len:
        end = start + chunk_size
        chunk = text[start:end]
        chunks.append(chunk)
        start += (chunk_size - overlap)
    return chunks

@app.route('/')
def index():
    return app.send_static_file('index.html')

@app.route('/api/upload', methods=['POST'])
def upload_pdf():
    global PDF_CHUNKS
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "Empty filename"}), 400
        
    try:
        pdf_reader = PdfReader(file)
        full_text = ""
        for page in pdf_reader.pages:
            t = page.extract_text()
            if t:
                full_text += t + "\n"
        
        chunks = chunk_text(full_text)
        PDF_CHUNKS = []
        
        # Batch encode embeddings (max 100 per API call for safety)
        batch_size = 100
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i:i+batch_size]
            response = client.models.embed_content(
                model='gemini-embedding-001',
                contents=batch
            )
            for chunk_str, emb_obj in zip(batch, response.embeddings):
                PDF_CHUNKS.append({
                    "text": chunk_str,
                    "embedding": np.array(emb_obj.values)
                })
        
        return jsonify({"message": f"Successfully indexed {len(PDF_CHUNKS)} chunks from {file.filename}."})
    except Exception as e:
        logging.error(f"PDF upload failed: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/clear-rag', methods=['POST'])
def clear_rag():
    global PDF_CHUNKS
    PDF_CHUNKS = []
    return jsonify({"message": "RAG context cleared."})

@app.route('/api/chat', methods=['POST'])
def chat():
    try:
        data = request.get_json(force=True, silent=True)
        if data is None:
            return jsonify({"error": "Invalid JSON in request body"}), 400

        message = data.get('message', '')
        history_data = data.get('history', [])

        if not message:
            return jsonify({"error": "No message provided"}), 400

        # --- RAG INJECTION PHASE ---
        rag_context = ""
        if PDF_CHUNKS:
            try:
                query_emb_resp = client.models.embed_content(
                    model='gemini-embedding-001',
                    contents=message
                )
                query_vec = np.array(query_emb_resp.embeddings[0].values)

                # Cosine similarity ranking
                scored_chunks = []
                for chunk in PDF_CHUNKS:
                    norm_q = np.linalg.norm(query_vec)
                    norm_c = np.linalg.norm(chunk["embedding"])
                    if norm_q == 0 or norm_c == 0:
                        score = 0
                    else:
                        score = np.dot(query_vec, chunk["embedding"]) / (norm_q * norm_c)
                    scored_chunks.append((score, chunk["text"]))

                scored_chunks.sort(key=lambda x: x[0], reverse=True)
                top_texts = [c[1] for c in scored_chunks[:3]]

                rag_context = "\n\n--- RAG RETRIEVAL CONTEXT ---\n(The following information was retrieved from the uploaded document to help answer the user. Use it heavily if relevant.)\n" + "\n\n...".join(top_texts)
            except Exception as e:
                logging.error(f"RAG search failed: {e}")

        # Construct history array for Gemini
        contents = []
        for item in history_data:
            role = item.get('role', 'user')
            # Gemini only accepts 'user' and 'model' roles
            if role not in ('user', 'model'):
                role = 'user'
            text = item.get('text', '')
            if text:  # skip empty entries
                contents.append({
                    "role": role,
                    "parts": [{"text": text}]
                })

        # Append the newest message + hidden RAG context (if any)
        final_user_text = message + rag_context
        contents.append({
            "role": "user",
            "parts": [{"text": final_user_text}]
        })

        try:
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_INSTRUCTION
                )
            )
            # Safely extract text from response
            reply = None
            try:
                reply = response.text
            except Exception:
                # Some responses have candidates but .text throws
                if response.candidates:
                    for candidate in response.candidates:
                        if candidate.content and candidate.content.parts:
                            reply = candidate.content.parts[0].text
                            break

            if not reply:
                reply = "I couldn't generate a response. Please try rephrasing your question."

            return jsonify({"response": reply})
        except Exception as e:
            error_msg = str(e)
            logging.error(f"Error calling Gemini: {error_msg}")
            logging.error(traceback.format_exc())
            
            # Return user-friendly error messages
            if '429' in error_msg or 'RESOURCE_EXHAUSTED' in error_msg:
                friendly = "API quota exceeded. The free tier allows 20 requests/day for this model. Please wait and try again later, or use a different API key."
            elif 'PERMISSION_DENIED' in error_msg or '403' in error_msg:
                friendly = "API key is invalid or doesn't have permission. Please check your API key."
            elif 'INVALID_ARGUMENT' in error_msg or '400' in error_msg:
                friendly = "The request was invalid. Please try rephrasing your question."
            elif 'UNAVAILABLE' in error_msg or '503' in error_msg:
                friendly = "The AI service is temporarily unavailable. Please try again in a moment."
            else:
                friendly = "An error occurred while generating the response. Please try again."
            
            return jsonify({"error": friendly}), 500

    except Exception as e:
        logging.error(f"Unexpected error in /api/chat: {traceback.format_exc()}")
        return jsonify({"error": f"Server error: {str(e)}"}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000)
