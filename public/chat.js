// ============================================================
// CHAT MODULE — Claude chat, ask-user-question, toolbar
// ============================================================
(function chatModule() {
  const { state, escHtml, sendWs } = window.dashboard;

  // --- DOM refs ---
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');
  const chatStopBtn = document.getElementById('chatStopBtn');
  const welcomeHTML = chatMessages?.querySelector('.chat-welcome')?.outerHTML || '';
  const chatStatusEl = document.getElementById('chatStatus');

  let chatAutoScroll = true;

  chatMessages?.addEventListener('scroll', () => {
    const el = chatMessages;
    chatAutoScroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  });

  function chatScrollToBottom() {
    if (chatAutoScroll && chatMessages) {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  // --- Send / input ---

  function sendChat() {
    const prompt = chatInput?.value?.trim();
    if (!prompt) return;
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    appendChatBubble(prompt, 'user');
    state.chatCurrentEl = null;
    sendWs({ type: 'chat:send', prompt });
    chatInput.value = '';
    chatInput.style.height = 'auto';
  }

  chatSendBtn?.addEventListener('click', sendChat);
  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  chatInput?.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
  });

  chatStopBtn?.addEventListener('click', () => {
    if (state.ws?.readyState === WebSocket.OPEN) {
      sendWs({ type: 'chat:stop' });
    }
  });

  // --- Bubbles ---

  function appendChatBubble(text, role) {
    if (!chatMessages) return;
    const welcome = chatMessages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble chat-${role}`;
    bubble.textContent = text;
    chatMessages.appendChild(bubble);
    chatScrollToBottom();
    return bubble;
  }

  function appendChatText(text, role) {
    if (!chatMessages) return;
    if (role === 'assistant' && state.chatCurrentEl) {
      state.chatCurrentEl.textContent += text;
    } else {
      state.chatCurrentEl = appendChatBubble(text, role);
    }
    chatScrollToBottom();
  }

  // --- Stream event handling ---

  function handleChatEvent(event) {
    if (!chatMessages) return;

    if (event.type === 'content_block_delta') {
      const text = event.delta?.text || '';
      if (text) {
        if (!state.chatCurrentEl) {
          state.chatCurrentEl = appendChatBubble('', 'assistant');
        }
        state.chatCurrentEl.textContent += text;
        chatScrollToBottom();
      }
    } else if (event.type === 'result') {
      if (event.result) {
        if (!state.chatCurrentEl) {
          state.chatCurrentEl = appendChatBubble('', 'assistant');
        }
        state.chatCurrentEl.textContent = event.result;
        chatScrollToBottom();
      }
      state.chatCurrentEl = null;
    } else if (event.type === 'message_stop') {
      state.chatCurrentEl = null;
    }
  }

  function updateChatStatus(status) {
    if (chatStatusEl) {
      chatStatusEl.textContent = status;
      chatStatusEl.className = `chat-status ${status}`;
    }
    if (chatStopBtn) {
      chatStopBtn.classList.toggle('hidden', status !== 'running');
    }
    if (chatSendBtn) {
      chatSendBtn.disabled = status === 'running';
    }
  }

  // ============================================================
  // TOOLBAR: PROJECT DIR + PROFILE SELECT
  // ============================================================

  const chatCwdBtn = document.getElementById('chatCwdBtn');
  const chatCwdLabel = document.getElementById('chatCwdLabel');
  const chatCwdInput = document.getElementById('chatCwdInput');
  const chatCwdSetBtn = document.getElementById('chatCwdSetBtn');
  const chatProfileSelect = document.getElementById('chatProfileSelect');

  chatCwdBtn?.addEventListener('click', () => {
    const editing = !chatCwdInput.classList.contains('hidden');
    if (editing) {
      chatCwdInput.classList.add('hidden');
      chatCwdSetBtn.classList.add('hidden');
      chatCwdLabel.classList.remove('hidden');
    } else {
      chatCwdInput.value = chatCwdLabel.textContent || '';
      chatCwdLabel.classList.add('hidden');
      chatCwdInput.classList.remove('hidden');
      chatCwdSetBtn.classList.remove('hidden');
      chatCwdInput.focus();
    }
  });

  chatCwdSetBtn?.addEventListener('click', () => {
    const cwd = chatCwdInput?.value?.trim();
    if (!cwd) return;
    sendWs({ type: 'chat:setCwd', cwd });
    chatCwdInput.classList.add('hidden');
    chatCwdSetBtn.classList.add('hidden');
    chatCwdLabel.classList.remove('hidden');
  });

  chatCwdInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      chatCwdSetBtn?.click();
    } else if (e.key === 'Escape') {
      chatCwdInput.classList.add('hidden');
      chatCwdSetBtn.classList.add('hidden');
      chatCwdLabel.classList.remove('hidden');
    }
  });

  chatProfileSelect?.addEventListener('change', (e) => {
    const name = e.target.value;
    if (!name) return;
    sendWs({ type: 'chat:switchProfile', name });
  });

  function renderChatProfileSelect() {
    if (!chatProfileSelect) return;
    chatProfileSelect.innerHTML = '';
    for (const p of (state.profiles || [])) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.builtin ? p.label : p.label || p.name;
      opt.title = p.description || '';
      chatProfileSelect.appendChild(opt);
    }
    chatProfileSelect.value = state.activeProfileName || 'full';
    const info = document.getElementById('chatProfileInfo');
    if (info && state.capabilities) {
      const c = state.capabilities;
      const parts = [];
      if (c.model) parts.push(c.model);
      if (c.effort) parts.push(c.effort);
      if (c.permissionMode && c.permissionMode !== 'default') parts.push(c.permissionMode);
      if (c.maxTurns) parts.push(c.maxTurns + ' turns');
      info.textContent = parts.length ? `(${parts.join(', ')})` : '';
    }
  }

  function updateChatSettings(msg) {
    if (msg.cwd) {
      if (chatCwdLabel) chatCwdLabel.textContent = msg.cwd;
      if (chatCwdInput) chatCwdInput.placeholder = msg.cwd;
    }
    if (msg.profiles) state.profiles = msg.profiles;
    if (msg.knownTools) state.knownTools = msg.knownTools;
    if (msg.knownSkills) state.knownSkills = msg.knownSkills;
    if (msg.hookEvents) state.hookEvents = msg.hookEvents;
    if (msg.matcherEvents) state.matcherEvents = msg.matcherEvents;
    if (msg.mcpServers) state.mcpServers = msg.mcpServers;
    if (msg.capabilities) {
      state.capabilities = msg.capabilities;
      state.activeProfileName = msg.capabilities.name;
    }
    if (msg.capabilities || msg.profiles) {
      renderChatProfileSelect();
    }
  }

  // ============================================================
  // ASK USER QUESTION
  // ============================================================

  function showAskQuestion(toolUseId, questions) {
    if (!chatMessages) return;

    const welcome = chatMessages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    // Auto-switch to Claude tab
    const claudeTab = document.querySelector('[data-view="claude"]');
    if (claudeTab && !claudeTab.classList.contains('active')) {
      claudeTab.click();
    }

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-question';
    bubble.dataset.toolUseId = toolUseId;

    let html = '';
    for (let qi = 0; qi < (questions || []).length; qi++) {
      const q = questions[qi];
      const isMulti = !!q.multiSelect;

      if (qi > 0) html += `<div class="chat-question-divider"></div>`;
      if (q.header) {
        html += `<div class="chat-question-header">${escHtml(q.header)}</div>`;
      }
      html += `<div class="chat-question-text">${escHtml(q.question)}</div>`;
      if (isMulti) {
        html += `<div class="chat-question-hint">Select one or more, then submit</div>`;
      }

      if (q.options && q.options.length > 0) {
        html += `<div class="chat-options" data-qi="${qi}" data-multi="${isMulti}">`;
        for (const opt of q.options) {
          html += `<button class="chat-option-btn" data-qi="${qi}" data-label="${escHtml(opt.label)}">`;
          if (isMulti) {
            html += `<span class="chat-option-check"></span>`;
          }
          html += `<span class="chat-option-label">${escHtml(opt.label)}</span>`;
          if (opt.description) {
            html += `<span class="chat-option-desc">${escHtml(opt.description)}</span>`;
          }
          html += `</button>`;
        }
        html += `</div>`;
      }
    }

    const needsSubmit = questions.length > 1 || questions.some(q => q.multiSelect);
    if (needsSubmit) {
      html += `<button class="chat-submit-btn" disabled>Submit</button>`;
    }

    bubble.innerHTML = html;

    const allQuestions = questions || [];
    const submitBtn = bubble.querySelector('.chat-submit-btn');

    function checkSubmitReady() {
      if (!submitBtn) return;
      const allAnswered = allQuestions.every((_, qi) => {
        const sel = bubble.querySelectorAll(`.chat-option-btn.selected[data-qi="${qi}"]`);
        return sel.length > 0;
      });
      submitBtn.disabled = !allAnswered;
    }

    bubble.querySelectorAll('.chat-option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const qi = parseInt(btn.dataset.qi);
        const q = allQuestions[qi];
        const isMulti = !!q?.multiSelect;
        const optionsContainer = bubble.querySelector(`.chat-options[data-qi="${qi}"]`);

        if (isMulti) {
          btn.classList.toggle('selected');
        } else {
          optionsContainer.querySelectorAll('.chat-option-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');

          if (!needsSubmit) {
            const answer = [{ question: q.question, answer: btn.dataset.label }];
            sendQuestionAnswer(toolUseId, answer);
            bubble.querySelectorAll('.chat-option-btn').forEach(b => b.disabled = true);
            bubble.classList.add('answered');
            return;
          }
        }

        checkSubmitReady();
      });
    });

    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        const answer = allQuestions.map((q, qi) => {
          const selected = bubble.querySelectorAll(`.chat-option-btn.selected[data-qi="${qi}"]`);
          const labels = Array.from(selected).map(b => b.dataset.label);
          return {
            question: q.question,
            answer: q.multiSelect ? labels : labels[0] || '',
          };
        });

        sendQuestionAnswer(toolUseId, answer);
        bubble.querySelectorAll('.chat-option-btn').forEach(b => b.disabled = true);
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitted';
        bubble.classList.add('answered');
      });
    }

    chatMessages.appendChild(bubble);
    chatScrollToBottom();
  }

  function sendQuestionAnswer(toolUseId, answer) {
    if (state.ws?.readyState === WebSocket.OPEN) {
      sendWs({ type: 'ask:answer', toolUseId, answer });
    }
  }

  function markQuestionAnswered(toolUseId) {
    const bubble = chatMessages?.querySelector(`.chat-question[data-tool-use-id="${toolUseId}"]`);
    if (bubble) {
      bubble.classList.add('answered');
    }
  }

  function markQuestionTimeout(toolUseId) {
    const bubble = chatMessages?.querySelector(`.chat-question[data-tool-use-id="${toolUseId}"]`);
    if (bubble) {
      bubble.classList.add('timed-out');
      const notice = document.createElement('div');
      notice.className = 'chat-question-timeout';
      notice.textContent = 'Timed out - error forwarded as-is';
      bubble.appendChild(notice);
    }
  }

  // --- Session reset ---

  function resetChatView() {
    if (chatMessages) {
      chatMessages.innerHTML = welcomeHTML;
    }
    state.chatCurrentEl = null;
    updateChatStatus('idle');
  }

  // --- Message router ---

  function handleMessage(msg) {
    switch (msg.type) {
      case 'chat:event':
        handleChatEvent(msg.event);
        break;
      case 'chat:output':
        appendChatText(msg.text, msg.role || 'assistant');
        break;
      case 'chat:error':
        appendChatBubble(msg.text || 'Unknown error', 'error');
        break;
      case 'chat:status':
        updateChatStatus(msg.status);
        break;
      case 'chat:settings':
        updateChatSettings(msg);
        break;
      case 'ask:question':
        showAskQuestion(msg.toolUseId, msg.questions);
        break;
      case 'ask:answered':
        markQuestionAnswered(msg.toolUseId);
        break;
      case 'ask:timeout':
        markQuestionTimeout(msg.toolUseId);
        break;
      case 'session:switched':
        resetChatView();
        break;
    }
  }

  function updateProfiles(profiles) {
    state.profiles = profiles;
    renderChatProfileSelect();
  }

  // --- Export ---
  window.chatModule = { handleMessage, updateProfiles };
})();
