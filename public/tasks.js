// ============================================================
// TASKS MODULE — Task/todo panel, drag, SSE interception
// ============================================================
(function taskModule() {
  const { state } = window.dashboard;

  // --- DOM refs ---
  const taskPanel = document.getElementById('taskPanel');
  const taskPanelList = document.getElementById('taskPanelList');
  const taskPanelClose = document.getElementById('taskPanelClose');
  const taskLauncher = document.getElementById('taskLauncher');

  // --- Constants ---
  const TASK_STATUS_ICONS = {
    pending:     '\u25CB',  // ○
    in_progress: '\u25E6',  // ◦
    completed:   '\u2713',  // ✓
    blocked:     '\u29B8',  // ⦸
    failed:      '\u2717',  // ✗
    cancelled:   '\u2014',  // —
  };

  const TODO_STATUS_ICONS = {
    pending:     '\u2610',  // ☐
    in_progress: '\u25B6',  // ▶
    completed:   '\u2611',  // ☑
  };

  // --- Panel controls ---

  taskPanelClose?.addEventListener('click', () => {
    state.taskPanelCollapsed = true;
    taskPanel?.classList.add('hidden');
    updateTaskLauncher();
  });

  taskLauncher?.addEventListener('click', () => {
    state.taskPanelCollapsed = false;
    renderTaskPanel();
    updateTaskLauncher();
  });

  function updateTaskLauncher() {
    if (!taskLauncher) return;
    const hasItems = Object.keys(state.tasks).length > 0 || state.todos.length > 0;
    if (hasItems && state.taskPanelCollapsed) {
      taskLauncher.classList.remove('hidden');
    } else {
      taskLauncher.classList.add('hidden');
    }
  }

  // --- Drag support ---
  {
    const header = taskPanel?.querySelector('.task-panel-header');
    let dragging = false, startX, startY, startLeft, startTop;

    header?.addEventListener('mousedown', (e) => {
      if (e.target.closest('.task-panel-close')) return;
      dragging = true;
      const rect = taskPanel.getBoundingClientRect();
      const parentRect = taskPanel.offsetParent.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left - parentRect.left;
      startTop = rect.top - parentRect.top;
      taskPanel.style.left = startLeft + 'px';
      taskPanel.style.top = startTop + 'px';
      taskPanel.style.right = 'auto';
      taskPanel.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const parentRect = taskPanel.offsetParent.getBoundingClientRect();
      let newLeft = startLeft + dx;
      let newTop = startTop + dy;
      newLeft = Math.max(0, Math.min(newLeft, parentRect.width - taskPanel.offsetWidth));
      newTop = Math.max(0, Math.min(newTop, parentRect.height - taskPanel.offsetHeight));
      taskPanel.style.left = newLeft + 'px';
      taskPanel.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      taskPanel?.classList.remove('dragging');
    });
  }

  // --- SSE interception ---

  function interceptTaskToolSSE(event) {
    if (event.eventType === 'content_block_start' && event.data?.content_block?.type === 'tool_use') {
      const cb = event.data.content_block;
      if (cb.name === 'TaskCreate' || cb.name === 'TaskUpdate' || cb.name === 'TodoWrite') {
        state.pendingTaskTools[event.data.index] = { name: cb.name, inputJson: '' };
      }
    } else if (event.eventType === 'content_block_delta' && event.data?.delta?.type === 'input_json_delta') {
      const pending = state.pendingTaskTools[event.data.index];
      if (pending) {
        pending.inputJson += event.data.delta.partial_json || '';
      }
    } else if (event.eventType === 'content_block_stop') {
      const pending = state.pendingTaskTools[event.data?.index];
      if (pending) {
        delete state.pendingTaskTools[event.data.index];
        try {
          const input = JSON.parse(pending.inputJson);
          if (pending.name === 'TaskCreate') {
            applyTaskCreate(input);
          } else if (pending.name === 'TaskUpdate') {
            applyTaskUpdate(input);
          } else if (pending.name === 'TodoWrite') {
            applyTodoWrite(input);
          }
        } catch {}
      }
    }
  }

  // --- Apply functions ---

  function applyTaskCreate(input) {
    const id = input.id || input.taskId || `task-${Date.now()}`;
    state.tasks[id] = {
      id,
      subject: input.subject || input.title || '',
      description: input.description || '',
      status: input.status || 'pending',
      activeForm: input.activeForm || null,
      blockedBy: [],
      blocks: [],
    };
    renderTaskPanel();
  }

  function applyTaskUpdate(input) {
    const id = input.id || input.taskId;
    if (!id) return;
    const task = state.tasks[id];
    if (!task) return;

    if (input.status) task.status = input.status;
    if (input.subject) task.subject = input.subject;
    if (input.description !== undefined) task.description = input.description;
    if (input.activeForm !== undefined) task.activeForm = input.activeForm;

    if (input.addBlockedBy) {
      const deps = Array.isArray(input.addBlockedBy) ? input.addBlockedBy : [input.addBlockedBy];
      for (const dep of deps) {
        if (!task.blockedBy.includes(dep)) task.blockedBy.push(dep);
      }
    }
    if (input.addBlocks) {
      const deps = Array.isArray(input.addBlocks) ? input.addBlocks : [input.addBlocks];
      for (const dep of deps) {
        if (!task.blocks.includes(dep)) task.blocks.push(dep);
        if (state.tasks[dep] && !state.tasks[dep].blockedBy.includes(id)) {
          state.tasks[dep].blockedBy.push(id);
        }
      }
    }

    if (task.status === 'completed') {
      for (const downstreamId of task.blocks) {
        const downstream = state.tasks[downstreamId];
        if (!downstream) continue;
        downstream.blockedBy = downstream.blockedBy.filter(b => b !== id);
        if (downstream.blockedBy.length === 0 && downstream.status === 'blocked') {
          downstream.status = 'pending';
        }
      }
    }

    renderTaskPanel();
  }

  function applyTodoWrite(input) {
    const todos = input.todos || [];
    state.todos = todos.map((t, i) => ({
      id: t.id || `todo-${i}`,
      content: t.content || '',
      status: t.status || 'pending',
      priority: t.priority || null,
    }));
    renderTaskPanel();
  }

  // --- Render ---

  function renderTaskPanel() {
    if (!taskPanel || !taskPanelList) return;
    const tasks = Object.values(state.tasks);
    const todos = state.todos;
    if (tasks.length === 0 && todos.length === 0) {
      taskPanel.classList.add('hidden');
      updateTaskLauncher();
      return;
    }
    if (!state.taskPanelCollapsed) {
      taskPanel.classList.remove('hidden');
    }
    updateTaskLauncher();

    const headerLabel = taskPanel.querySelector('.task-panel-header span');
    if (headerLabel) {
      if (tasks.length > 0 && todos.length > 0) headerLabel.textContent = 'Tasks & Todos';
      else if (todos.length > 0) headerLabel.textContent = 'Todos';
      else headerLabel.textContent = 'Tasks';
    }

    taskPanelList.innerHTML = '';

    const order = { in_progress: 0, pending: 1, blocked: 2, failed: 3, cancelled: 4, completed: 5 };

    if (tasks.length > 0) {
      if (todos.length > 0) {
        const label = document.createElement('div');
        label.className = 'task-section-label';
        label.textContent = 'Tasks';
        taskPanelList.appendChild(label);
      }
      tasks.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
      for (const task of tasks) {
        const item = document.createElement('div');
        item.className = 'task-item';

        const icon = document.createElement('span');
        icon.className = `task-status-icon ${task.status}`;
        icon.textContent = TASK_STATUS_ICONS[task.status] || '\u25CB';
        item.appendChild(icon);

        const body = document.createElement('div');
        body.className = 'task-body';

        const subj = document.createElement('div');
        subj.className = 'task-subject';
        subj.textContent = task.subject;
        body.appendChild(subj);

        if (task.description) {
          const desc = document.createElement('div');
          desc.className = 'task-desc';
          desc.textContent = task.description;
          body.appendChild(desc);
        }

        if (task.status === 'in_progress' && task.activeForm) {
          const af = document.createElement('div');
          af.className = 'task-active-form';
          af.textContent = task.activeForm;
          body.appendChild(af);
        }

        if (task.blockedBy.length > 0) {
          const bl = document.createElement('div');
          bl.className = 'task-blocked-label';
          const names = task.blockedBy.map(bid => state.tasks[bid]?.subject || bid).join(', ');
          bl.textContent = `blocked by: ${names}`;
          body.appendChild(bl);
        }

        item.appendChild(body);
        taskPanelList.appendChild(item);
      }
    }

    if (todos.length > 0) {
      if (tasks.length > 0) {
        const label = document.createElement('div');
        label.className = 'task-section-label';
        label.textContent = 'Todos';
        taskPanelList.appendChild(label);
      }
      for (const todo of todos) {
        const item = document.createElement('div');
        item.className = 'task-item todo-item';

        const icon = document.createElement('span');
        icon.className = `todo-status-icon ${todo.status}`;
        icon.textContent = TODO_STATUS_ICONS[todo.status] || '\u2610';
        item.appendChild(icon);

        const body = document.createElement('div');
        body.className = 'task-body';

        const content = document.createElement('div');
        content.className = 'todo-content';
        content.textContent = todo.content;
        body.appendChild(content);

        if (todo.priority) {
          const prio = document.createElement('span');
          prio.className = `todo-priority ${todo.priority}`;
          prio.textContent = todo.priority;
          body.appendChild(prio);
        }

        item.appendChild(body);
        taskPanelList.appendChild(item);
      }
    }
  }

  // --- Session reset ---

  function resetTasks() {
    state.tasks = {};
    state.todos = [];
    state.pendingTaskTools = {};
    state.taskPanelCollapsed = false;
    if (taskPanel) taskPanel.classList.add('hidden');
    updateTaskLauncher();
  }

  // --- Message router ---

  function handleMessage(msg) {
    switch (msg.type) {
      case 'session:switched':
        resetTasks();
        break;
    }
  }

  // --- Export ---
  window.taskModule = { handleMessage, interceptSSE: interceptTaskToolSSE };
})();
