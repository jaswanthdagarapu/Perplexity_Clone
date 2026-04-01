document.addEventListener("DOMContentLoaded", () => {
    const textarea = document.querySelector('.search-textarea');
    const hint = document.querySelector('.search-placeholder-hint');
    const sendBtn = document.getElementById('send-btn');
    const micBtn = document.getElementById('mic-btn');

    // Auto-resize textarea
    textarea.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
        
        // Hide hint when there is text
        if (this.value.trim().length > 0) {
            hint.style.display = 'none';
            sendBtn.disabled = false;
        } else {
            hint.style.display = 'flex';
            sendBtn.disabled = true;
        }
    });

    // Hide hint strictly on focus to match the feeling
    textarea.addEventListener('focus', () => {
        hint.style.display = 'none';
    });

    // Show hint on blur if empty
    textarea.addEventListener('blur', () => {
        if (textarea.value.trim().length === 0) {
            hint.style.display = 'flex';
        }
    });

    // Handle Category Chips highlighting
    const chips = document.querySelectorAll('.category-chip');
    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            chips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
        });
    });

    // === File Upload Integration (PDF RAG) ===
    const uploadBtn = document.getElementById('upload-btn');
    const pdfUpload = document.getElementById('pdf-upload');
    const uploadStatus = document.getElementById('upload-status');
    const attachedFileBar = document.getElementById('attached-file-bar');
    let uploadAbortController = null;

    function hideAttachedFile() {
        if (attachedFileBar) attachedFileBar.style.display = 'none';
        if (uploadStatus) {
            uploadStatus.className = 'attached-file-chip';
            uploadStatus.innerHTML = '';
        }
    }

    function showAttachedFileBar() {
        if (attachedFileBar) attachedFileBar.style.display = 'flex';
    }

    if (uploadBtn && pdfUpload) {
        uploadBtn.addEventListener('click', (e) => {
            e.preventDefault();
            pdfUpload.click();
        });

        pdfUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            // Show uploading state with cancel button
            uploadAbortController = new AbortController();
            showAttachedFileBar();
            uploadStatus.className = 'attached-file-chip uploading';
            uploadStatus.innerHTML = `<div class="spinner"></div> <span class="pdf-filename">${file.name.length > 25 ? file.name.substring(0, 22) + '...' : file.name}</span> <button class="pdf-cancel-btn" id="pdf-cancel-upload" title="Cancel upload"><i data-lucide="x"></i></button>`;
            lucide.createIcons();

            // Cancel during upload
            document.getElementById('pdf-cancel-upload').addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (uploadAbortController) uploadAbortController.abort();
                hideAttachedFile();
                fetch('/api/clear-rag', { method: 'POST' }).catch(() => {});
            });

            const formData = new FormData();
            formData.append('file', file);

            try {
                const response = await fetch('/api/upload', {
                    method: 'POST',
                    body: formData,
                    signal: uploadAbortController.signal
                });
                
                let data;
                const text = await response.text();
                try {
                    data = JSON.parse(text);
                } catch (parseErr) {
                    console.error('Upload JSON parse error:', parseErr, 'Raw:', text);
                    throw new Error('Server returned an invalid response');
                }
                
                if (response.ok) {
                    showPdfReady(file.name);
                } else {
                    uploadStatus.className = 'attached-file-chip error';
                    uploadStatus.innerHTML = `<i data-lucide="alert-circle"></i> <span>${data.error || 'Upload failed'}</span> <button class="pdf-cancel-btn" id="pdf-cancel-error" title="Dismiss"><i data-lucide="x"></i></button>`;
                    lucide.createIcons();
                    document.getElementById('pdf-cancel-error').addEventListener('click', () => hideAttachedFile());
                }
            } catch (error) {
                if (error.name === 'AbortError') {
                    // User cancelled — already hidden
                    return;
                }
                uploadStatus.className = 'attached-file-chip error';
                uploadStatus.innerHTML = `<i data-lucide="alert-circle"></i> <span>${error.message || 'Upload failed'}</span> <button class="pdf-cancel-btn" id="pdf-cancel-error2" title="Dismiss"><i data-lucide="x"></i></button>`;
                lucide.createIcons();
                document.getElementById('pdf-cancel-error2').addEventListener('click', () => hideAttachedFile());
            }
            pdfUpload.value = '';
            uploadAbortController = null;
        });
    }

    // Show PDF ready badge with cancel button
    function showPdfReady(filename) {
        showAttachedFileBar();
        uploadStatus.className = 'attached-file-chip ready';
        const shortName = filename.length > 25 ? filename.substring(0, 22) + '...' : filename;
        uploadStatus.innerHTML = `<i data-lucide="file-text"></i> <span class="pdf-filename">${shortName}</span> <button class="pdf-cancel-btn" id="pdf-cancel-btn" title="Remove PDF"><i data-lucide="x"></i></button>`;
        lucide.createIcons();

        document.getElementById('pdf-cancel-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            uploadStatus.className = 'attached-file-chip uploading';
            uploadStatus.innerHTML = '<div class="spinner"></div> <span>Removing...</span>';
            try {
                await fetch('/api/clear-rag', { method: 'POST' });
            } catch (clearErr) {
                console.warn('Failed to clear RAG:', clearErr);
            }
            hideAttachedFile();
        });
    }

    // === Backend Chat Integration ===
    const chatHistory = document.getElementById('chat-history');
    const logoContainer = document.getElementById('logo-container');
    const suggestionsPanel = document.querySelector('.suggestions-panel');
    const historyView = document.getElementById('history-view');
    const chatInterface = document.getElementById('chat-interface');
    
    // Conversation history array for threading
    let conversationHistory = [];
    let savedChats = JSON.parse(localStorage.getItem('savedChats') || '[]');
    let currentChatId = null;

    function saveCurrentChat() {
        if (conversationHistory.length === 0) return;
        if (!currentChatId) {
            currentChatId = Date.now().toString();
            savedChats.push({
                id: currentChatId,
                title: conversationHistory[0].text.substring(0, 40) + '...',
                messages: [...conversationHistory]
            });
        } else {
            const index = savedChats.findIndex(c => c.id === currentChatId);
            if (index > -1) {
                savedChats[index].messages = [...conversationHistory];
            }
        }
        localStorage.setItem('savedChats', JSON.stringify(savedChats));
        renderSidebarRecent();
    }

    const sidebarRecentList = document.getElementById('sidebar-recent-list');

    function renderSidebarRecent() {
        if (!sidebarRecentList) return;
        sidebarRecentList.innerHTML = '';
        
        if (savedChats.length === 0) {
            sidebarRecentList.innerHTML = '<p class="recent-subtitle">Recent and active threads will appear here.</p>';
            return;
        }
        
        // Show up to 6 recent chats in the sidebar
        savedChats.slice().reverse().slice(0, 6).forEach(chat => {
            const item = document.createElement('div');
            item.classList.add('sidebar-recent-item');
            item.textContent = chat.title;
            item.onclick = () => loadActiveChat(chat.id);
            sidebarRecentList.appendChild(item);
        });
    }

    function loadActiveChat(id) {
        const chat = savedChats.find(c => c.id === id);
        if(!chat) return;
        currentChatId = chat.id;
        conversationHistory = [...chat.messages];
        
        historyView.style.display = 'none';
        chatInterface.style.display = 'flex';
        
        chatHistory.innerHTML = '';
        chatHistory.style.display = 'flex';
        logoContainer.style.display = 'none';
        if(suggestionsPanel) suggestionsPanel.style.display = 'none';

        conversationHistory.forEach(msg => {
            appendMessage(msg.role === 'model' ? 'ai' : 'user', msg.text);
        });
    }
    
    // Initial Render
    renderSidebarRecent();

    // Initialize KaTeX extension for marked
    if (typeof marked !== 'undefined' && typeof window.markedKatex !== 'undefined') {
        marked.use(window.markedKatex({ throwOnError: false }));
    }

    function appendMessage(role, text) {
        // Show chat history container if hidden
        if (chatHistory.style.display !== 'flex') {
            chatHistory.style.display = 'flex';
            logoContainer.style.display = 'none';
            if (suggestionsPanel) suggestionsPanel.style.display = 'none';
        }

        const msgDiv = document.createElement('div');
        msgDiv.classList.add('chat-message');
        
        const bubble = document.createElement('div');
        if (role === 'user') {
            bubble.classList.add('message-user');
            bubble.textContent = text;
        } else if (role === 'ai') {
            bubble.classList.add('message-ai');
            // Assuming marked.js is available for Markdown parsing
            if (typeof marked !== 'undefined') {
                bubble.innerHTML = marked.parse(text);
            } else {
                bubble.textContent = text;
            }
        } else if (role === 'loading') {
            bubble.classList.add('loading-indicator');
            bubble.innerHTML = '<div class="spinner"></div><span>Thinking...</span>';
            msgDiv.id = 'loading-msg';
        }

        msgDiv.appendChild(bubble);
        chatHistory.appendChild(msgDiv);
        
        // Scroll to bottom
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function removeLoading() {
        const loading = document.getElementById('loading-msg');
        if (loading) loading.remove();
    }

    async function sendMessage(message) {
        if (!message.trim()) return;

        appendMessage('user', message);
        appendMessage('loading', '');

        // 60-second timeout for long AI responses
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ 
                    message: message,
                    history: conversationHistory 
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            let data;
            try {
                const responseText = await response.text();
                data = JSON.parse(responseText);
            } catch (parseErr) {
                console.error('Chat JSON parse failed:', parseErr);
                removeLoading();
                appendMessage('ai', 'Error: The server returned an unexpected response. Make sure the backend server is running on port 5000.');
                return;
            }

            removeLoading();

            if (response.ok && data.response) {
                appendMessage('ai', data.response);
                conversationHistory.push({ role: 'user', text: message });
                conversationHistory.push({ role: 'model', text: data.response });
                saveCurrentChat();
            } else {
                const errorMsg = data.error || 'Failed to get response';
                appendMessage('ai', `⚠️ ${errorMsg}`);
            }
        } catch (error) {
            clearTimeout(timeoutId);
            console.error('Chat fetch error:', error);
            removeLoading();
            if (error.name === 'AbortError') {
                appendMessage('ai', '⚠️ Request timed out. The AI took too long to respond. Please try again.');
            } else {
                appendMessage('ai', `⚠️ Connection error: Could not reach the server. Make sure the backend is running.`);
            }
        }
    }

    // Handle New Thread
    document.getElementById('new-thread-btn').addEventListener('click', (e) => {
        e.preventDefault();
        saveCurrentChat(); // Ensure saved
        conversationHistory = [];
        currentChatId = null;
        chatHistory.innerHTML = '';
        chatHistory.style.display = 'none';
        logoContainer.style.display = 'flex';
        if(suggestionsPanel) suggestionsPanel.style.display = 'block';
        
        historyView.style.display = 'none';
        chatInterface.style.display = 'flex';
        
        // Clear RAG context from backend
        fetch('/api/clear-rag', { method: 'POST' }).catch(() => {});
        
        // Hide attached file bar
        hideAttachedFile();
        
        // Remove active state
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        document.querySelector('.nav-item').nextElementSibling.classList.add('active'); // Fallback highlight
    });

    // Handle History View
    document.getElementById('history-btn').addEventListener('click', (e) => {
        e.preventDefault();
        chatInterface.style.display = 'none';
        historyView.style.display = 'flex';
        
        const historyList = document.getElementById('history-list');
        historyList.innerHTML = '';
        
        if (savedChats.length === 0) {
            historyList.innerHTML = '<p style="color: var(--text-secondary);">No previous conversations.</p>';
            return;
        }
        
        savedChats.slice().reverse().forEach(chat => {
            const item = document.createElement('div');
            item.classList.add('history-item');
            item.textContent = chat.title;
            item.onclick = () => loadActiveChat(chat.id);
            historyList.appendChild(item);
        });
    });

    function submitInput() {
        const text = textarea.value.trim();
        if(!text) return;
        textarea.value = '';
        textarea.style.height = 'auto'; // trigger auto-resize to shrink it back
        hint.style.display = 'flex'; // show placeholder
        sendBtn.disabled = true;
        sendMessage(text);
    }

    // Handle Enter keypress
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitInput();
        }
    });

    // Handle Send Button click
    sendBtn.addEventListener('click', (e) => {
        e.preventDefault();
        submitInput();
    });

    // Handle Mic Button click via Web Speech API
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition && micBtn) {
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        
        let isListening = false;

        recognition.onstart = function() {
            isListening = true;
            micBtn.classList.add('mic-listening');
            textarea.placeholder = "Listening...";
        };

        recognition.onresult = function(event) {
            const transcript = event.results[0][0].transcript;
            textarea.value = (textarea.value + " " + transcript).trim();
            // Trigger input event to update everything
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        };

        recognition.onerror = function(event) {
            console.error(event.error);
        };

        recognition.onend = function() {
            isListening = false;
            micBtn.classList.remove('mic-listening');
            textarea.placeholder = "Ask anything...";
        };

        micBtn.addEventListener('click', () => {
            if (isListening) {
                recognition.stop();
            } else {
                recognition.start();
            }
        });
    } else if (micBtn) {
        // Fallback if Speech API not supported
        micBtn.addEventListener('click', () => {
            alert("Speech Recognition API is not supported in this browser.");
        });
    }

    // Option: click pills under suggestions to send a prompt
    const suggestionLinks = document.querySelectorAll('.suggestion-list a');
    suggestionLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            sendMessage(e.target.textContent);
        });
    });
});

