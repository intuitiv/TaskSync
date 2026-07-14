/**
 * TaskSync Extension - Webview Script
 * Handles tool call history, prompt queue, attachments, and file autocomplete
 */
(function () {
    const vscode = acquireVsCodeApi();
    const WEBVIEW_UI_VERSION = 'workers-tools-hierarchy-v7-memories-list';

    // Restore persisted state (survives sidebar switch)
    const previousState = vscode.getState() || {};

    // State
    let promptQueue = [];
    let queueEnabled = true; // Default to true (Queue mode ON by default)
    let planEnabled = false; // Plan mode
    let dropdownOpen = false;
    let currentAttachments = previousState.attachments || []; // Restore attachments
    let selectedCard = 'queue';
    let currentSessionCalls = []; // Current session tool calls (shown in chat)
    let persistedHistory = []; // Past sessions history (shown in modal)
    let pendingToolCall = null;
    let isProcessingResponse = false; // True when AI is processing user's response

    // Plan board state
    let currentPlan = null;
    let planExecuting = false;
    let proposedSplit = null; // { taskId, subtasks } for pending split review
    let isApprovalQuestion = false; // True when current pending question is an approval-type question
    let currentChoices = []; // Parsed choices from multi-choice questions

    // Settings state
    let soundEnabled = true;
    let interactiveApprovalEnabled = true;
    let sendWithCtrlEnter = false;
    let webexEnabled = false;
    let telegramEnabled = false;
    let autopilotEnabled = false;
    let autopilotText = '';
    let autopilotPrompts = [];
    let responseTimeout = 60;
    let sessionWarningHours = 2;
    let maxConsecutiveAutoResponses = 5;
    let turnBudgetAiu = 0;
    let debugLoggingEnabled = true;
    let rtkCompressionEnabled = false;
    let rtkInstalled = true;
    let autoCompactionDisabled = false;
    let extendedCacheTtl = false;
    let extendedCacheTtlMessages = false;
    let cacheKeepWarmEnabled = false;
    let cacheKeepWarmProbes = 1;
    let toolScopeMode = 'month'; // 'month' | 'turn' — toggles the tool-call table scope
    let obsView = 'turn'; // 'turn' | 'month' — drives the whole Observability panel
    let observabilityMetrics = {
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        nanoAiu: 0,
        lastRequest: { requestCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, nanoAiu: 0 },
        workspace: { requestCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, nanoAiu: 0 },
        overall: { requestCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, nanoAiu: 0 },
        perModel: [],
        overallCompaction: { count: 0, nanoAiu: 0 },
        turnRequests: [],
        turnEvents: [],
        turnSubagents: [],
        rtkCommandCount: 0,
        rtkSavedTokens: 0,
        rtkSavingsPct: 0,
        gradle: { runs: 0, optimizedRuns: 0, tasksAvoided: 0, configCacheReuses: 0, savedTokens: 0 },
        toolCalls: { totalCalls: 0, totalOutputTokens: 0, byTool: [], turn: { totalCalls: 0, totalOutputTokens: 0, byTool: [] } },
        lastRequestTs: 0,
        source: 'unavailable',
        updatedAt: 0
    };
    let memoriesList = [];
    // Keep timeout options aligned with select values to avoid invalid UI state.
    var RESPONSE_TIMEOUT_ALLOWED_VALUES = new Set([0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 150, 180, 210, 240]);
    var RESPONSE_TIMEOUT_DEFAULT = 60;
    // Human-like delay: random jitter simulates natural reading/typing time
    let humanLikeDelayEnabled = true;
    let humanLikeDelayMin = 2;  // minimum seconds
    let humanLikeDelayMax = 6;  // maximum seconds
    let autopilotTextDebounceTimer = null;
    let lastContextMenuTarget = null; // Tracks where right-click was triggered for copy fallback behavior
    let lastContextMenuTimestamp = 0; // Ensures stale right-click targets are not reused for copy
    var CONTEXT_MENU_COPY_MAX_AGE_MS = 30000;

    // Tracks local edits to prevent stale settings overwriting user input mid-typing.
    let autopilotTextEditVersion = 0;
    let autopilotTextLastSentVersion = 0;
    let reusablePrompts = [];
    let audioUnlocked = false; // Track if audio playback has been unlocked by user gesture

    // Slash command autocomplete state
    let slashDropdownVisible = false;
    let slashResults = [];
    let selectedSlashIndex = -1;
    let slashStartPos = -1;
    let slashDebounceTimer = null;

    // Persisted input value (restored from state)
    let persistedInputValue = previousState.inputValue || '';

    // Edit mode state
    let editingPromptId = null;

    // ── Voice Mode State ──
    let voiceMode = false;
    let voiceTaskId = null;
    let voiceRecognition = null;   // SpeechRecognition instance
    let voiceAudioContext = null;  // AudioContext for waveform
    let voiceAnalyser = null;      // AnalyserNode for waveform data
    let voiceStream = null;        // MediaStream from mic
    let voiceAnimationFrame = null;
    let voiceTranscript = '';      // Accumulated transcript
    let voiceInterimTranscript = ''; // Current interim result
    let editingOriginalPrompt = null;
    let savedInputValue = ''; // Save input value when entering edit mode

    // Autocomplete state
    let autocompleteVisible = false;
    let autocompleteResults = [];
    let selectedAutocompleteIndex = -1;
    let autocompleteStartPos = -1;
    let searchDebounceTimer = null;

    // DOM Elements
    let chatInput, sendBtn, attachBtn, modeBtn, modeDropdown, modeLabel;
    let inputHighlighter; // Overlay for syntax highlighting in input
    let queueSection, queueHeader, queueList, queueCount;
    let chatContainer, chipsContainer, autocompleteDropdown, autocompleteList, autocompleteEmpty;
    let inputContainer, inputAreaContainer, welcomeSection;
    let cardVibe, cardSpec, toolHistoryArea, pendingMessage;
    let historyModal, historyModalOverlay, historyModalList, historyModalClose, historyModalClearAll;
    // Edit mode elements
    let actionsLeft, actionsBar, editActionsContainer, editCancelBtn, editConfirmBtn;
    // Approval modal elements
    let approvalModal, approvalContinueBtn, approvalNoBtn;
    // Slash command elements
    let slashDropdown, slashList, slashEmpty;
    // Settings modal elements
    let settingsModal, settingsModalOverlay, settingsModalClose;
    let soundToggle, interactiveApprovalToggle, sendShortcutToggle, webexToggle, telegramToggle, autopilotEditBtn, autopilotToggle, autopilotTextInput, promptsList, addPromptBtn, addPromptForm;
    let debugLoggingToggle, rtkCompressionToggle, autoCompactionToggle;
    let extendedCacheTtlToggle, cacheKeepWarmToggle, cacheKeepWarmProbesInput;
    let extendedCacheTtlMessagesToggle;
    let autopilotPromptsList, autopilotAddBtn, addAutopilotPromptForm, autopilotPromptInput, saveAutopilotPromptBtn, cancelAutopilotPromptBtn;
    let responseTimeoutSelect, sessionWarningHoursSelect, maxAutoResponsesInput;
    let turnBudgetInput;
    let humanDelayToggle, humanDelayRangeContainer, humanDelayMinInput, humanDelayMaxInput;
    let observabilitySessionCalls, observabilityHistoryCount, observabilityPendingCommands, observabilityPendingAgents;
    let observabilitySource, observabilityRtkLine, observabilityModelTbody;
    let obsLastReqs, obsLastCredits, obsLastInput, obsLastOutput, obsLastCached;
    let obsWsReqs, obsWsCredits, obsWsInput, obsWsOutput, obsWsCached;
    let obsAllReqs, obsAllCredits;
    let observabilityMemoryList, observabilityMemoryCount;

    // ── Worker tab state ──
    var workerTasks = []; // [{id, role, task, status, createdAt}]
    var availableModels = []; // [{id, name, vendor, family, maxInputTokens}]
    var availableTools = []; // [{name, description}]
    var activeWorkerTaskId = { command: null, subagent: null };
    var currentTab = 'chat'; // 'chat' | 'commands' | 'subagents' | 'observability' | 'settings'

    // Mirror backend minimal worker tool allowlist to prevent oversized/stale payloads.
    var MINIMAL_WORKER_TOOL_NAMES = new Set([
        'execution_subagent',
        'search_subagent',
        'explore_subagent',
        'skill',
        'copilot_findFiles',
        'copilot_findTextInFiles',
        'copilot_readFile',
        'copilot_listDirectory',
        'copilot_getErrors',
        'copilot_getChangedFiles',
        'copilot_searchCodebase',
        'copilot_searchWorkspaceSymbols',
        'copilot_applyPatch',
        'copilot_createFile',
        'copilot_createDirectory',
        'copilot_replaceString',
        'copilot_multiReplaceString',
        'copilot_viewImage',
        'copilot_fetchWebPage',
        'copilot_runVscodeCommand',
        'copilot_getVSCodeAPI'
    ]);

    function filterMinimalWorkerTools(tools) {
        var list = Array.isArray(tools) ? tools : [];
        return list.filter(function (t) {
            return t && typeof t.name === 'string' && MINIMAL_WORKER_TOOL_NAMES.has(t.name);
        });
    }

    function init() {
        try {
            console.log('[TaskSync Webview] init() starting...');
            cacheDOMElements();
            createHistoryModal();
            createEditModeUI();
            createApprovalModal();
            createSettingsModal();
            createObservabilityTab();
            bindEventListeners();
            initVoiceControls();
            initWorkerTabs();
            unlockAudioOnInteraction(); // Enable audio after first user interaction
            console.log('[TaskSync Webview] Event listeners bound, pendingMessage element:', !!pendingMessage);
            renderQueue();
            updateModeUI();
            updateQueueVisibility();
            initCardSelection();
            initPlanBoard();

            // Restore persisted input value (when user switches sidebar tabs and comes back)
            if (chatInput && persistedInputValue) {
                chatInput.value = persistedInputValue;
                autoResizeTextarea();
                updateInputHighlighter();
                updateSendButtonState();
            }

            // Restore attachments display
            if (currentAttachments.length > 0) {
                updateChipsDisplay();
            }

            // Signal to extension that webview is ready to receive messages
            console.log('[TaskSync Webview] Sending webviewReady message');
            vscode.postMessage({ type: 'webviewReady', uiVersion: WEBVIEW_UI_VERSION });
        } catch (err) {
            console.error('[TaskSync] Init error:', err);
        }
    }

    /**
     * Save webview state to persist across sidebar visibility changes
     */
    function saveWebviewState() {
        vscode.setState({
            inputValue: chatInput ? chatInput.value : '',
            attachments: currentAttachments.filter(function (a) { return !a.isTemporary; }) // Don't persist temp images
        });
    }

    function cacheDOMElements() {
        chatInput = document.getElementById('chat-input');
        inputHighlighter = document.getElementById('input-highlighter');
        sendBtn = document.getElementById('send-btn');
        attachBtn = document.getElementById('attach-btn');
        modeBtn = document.getElementById('mode-btn');
        modeDropdown = document.getElementById('mode-dropdown');
        modeLabel = document.getElementById('mode-label');

        queueSection = document.getElementById('queue-section');
        queueHeader = document.getElementById('queue-header');
        queueList = document.getElementById('queue-list');
        queueCount = document.getElementById('queue-count');
        chatContainer = document.getElementById('chat-container');
        chipsContainer = document.getElementById('chips-container');
        autocompleteDropdown = document.getElementById('autocomplete-dropdown');
        autocompleteList = document.getElementById('autocomplete-list');
        autocompleteEmpty = document.getElementById('autocomplete-empty');
        inputContainer = document.getElementById('input-container');
        inputAreaContainer = document.getElementById('input-area-container');
        welcomeSection = document.getElementById('welcome-section');
        cardVibe = document.getElementById('card-vibe');
        cardSpec = document.getElementById('card-spec');
        autopilotToggle = document.getElementById('autopilot-toggle');
        toolHistoryArea = document.getElementById('tool-history-area');
        pendingMessage = document.getElementById('pending-message');
        // Slash command dropdown
        slashDropdown = document.getElementById('slash-dropdown');
        slashList = document.getElementById('slash-list');
        slashEmpty = document.getElementById('slash-empty');
        // Get actions bar elements for edit mode
        actionsBar = document.querySelector('.actions-bar');
        actionsLeft = document.querySelector('.actions-left');
    }

    function createHistoryModal() {
        // Create modal overlay
        historyModalOverlay = document.createElement('div');
        historyModalOverlay.className = 'history-modal-overlay hidden';
        historyModalOverlay.id = 'history-modal-overlay';

        // Create modal container
        historyModal = document.createElement('div');
        historyModal.className = 'history-modal';
        historyModal.id = 'history-modal';

        // Modal header
        var modalHeader = document.createElement('div');
        modalHeader.className = 'history-modal-header';

        var titleSpan = document.createElement('span');
        titleSpan.className = 'history-modal-title';
        titleSpan.textContent = 'History';
        modalHeader.appendChild(titleSpan);

        // Info text - left aligned after title
        var infoSpan = document.createElement('span');
        infoSpan.className = 'history-modal-info';
        infoSpan.textContent = 'History is stored in VS Code globalStorage/tool-history.json';
        modalHeader.appendChild(infoSpan);

        // Clear all button (icon only)
        historyModalClearAll = document.createElement('button');
        historyModalClearAll.className = 'history-modal-clear-btn';
        historyModalClearAll.innerHTML = '<span class="codicon codicon-trash"></span>';
        historyModalClearAll.title = 'Clear all history';
        modalHeader.appendChild(historyModalClearAll);

        // Close button
        historyModalClose = document.createElement('button');
        historyModalClose.className = 'history-modal-close-btn';
        historyModalClose.innerHTML = '<span class="codicon codicon-close"></span>';
        historyModalClose.title = 'Close';
        modalHeader.appendChild(historyModalClose);

        // Modal body (list)
        historyModalList = document.createElement('div');
        historyModalList.className = 'history-modal-list';
        historyModalList.id = 'history-modal-list';

        // Assemble modal
        historyModal.appendChild(modalHeader);
        historyModal.appendChild(historyModalList);
        historyModalOverlay.appendChild(historyModal);

        // Add to DOM
        document.body.appendChild(historyModalOverlay);
    }

    function createEditModeUI() {
        // Create edit actions container (hidden by default)
        editActionsContainer = document.createElement('div');
        editActionsContainer.className = 'edit-actions-container hidden';
        editActionsContainer.id = 'edit-actions-container';

        // Edit mode label
        var editLabel = document.createElement('span');
        editLabel.className = 'edit-mode-label';
        editLabel.textContent = 'Editing prompt';

        // Cancel button (X)
        editCancelBtn = document.createElement('button');
        editCancelBtn.className = 'icon-btn edit-cancel-btn';
        editCancelBtn.title = 'Cancel edit (Esc)';
        editCancelBtn.setAttribute('aria-label', 'Cancel editing');
        editCancelBtn.innerHTML = '<span class="codicon codicon-close"></span>';

        // Confirm button (✓)
        editConfirmBtn = document.createElement('button');
        editConfirmBtn.className = 'icon-btn edit-confirm-btn';
        editConfirmBtn.title = 'Confirm edit (Enter)';
        editConfirmBtn.setAttribute('aria-label', 'Confirm edit');
        editConfirmBtn.innerHTML = '<span class="codicon codicon-check"></span>';

        // Assemble edit actions
        editActionsContainer.appendChild(editLabel);
        var btnGroup = document.createElement('div');
        btnGroup.className = 'edit-btn-group';
        btnGroup.appendChild(editCancelBtn);
        btnGroup.appendChild(editConfirmBtn);
        editActionsContainer.appendChild(btnGroup);

        // Insert into actions bar (will be shown/hidden as needed)
        if (actionsBar) {
            actionsBar.appendChild(editActionsContainer);
        }
    }

    function createApprovalModal() {
        // Create approval bar that appears at the top of input-wrapper (inside the border)
        approvalModal = document.createElement('div');
        approvalModal.className = 'approval-bar hidden';
        approvalModal.id = 'approval-bar';
        approvalModal.setAttribute('role', 'toolbar');
        approvalModal.setAttribute('aria-label', 'Quick approval options');

        // Left side label
        var labelSpan = document.createElement('span');
        labelSpan.className = 'approval-label';
        labelSpan.textContent = 'Waiting on your input..';

        // Right side buttons container
        var buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'approval-buttons';

        // No/Reject button (secondary action - text only)
        approvalNoBtn = document.createElement('button');
        approvalNoBtn.className = 'approval-btn approval-reject-btn';
        approvalNoBtn.setAttribute('aria-label', 'Reject and provide custom response');
        approvalNoBtn.textContent = 'No';

        // Continue/Accept button (primary action)
        approvalContinueBtn = document.createElement('button');
        approvalContinueBtn.className = 'approval-btn approval-accept-btn';
        approvalContinueBtn.setAttribute('aria-label', 'Yes and continue');
        approvalContinueBtn.textContent = 'Yes';

        // Assemble buttons
        buttonsContainer.appendChild(approvalNoBtn);
        buttonsContainer.appendChild(approvalContinueBtn);

        // Assemble bar
        approvalModal.appendChild(labelSpan);
        approvalModal.appendChild(buttonsContainer);

        // Insert at top of input-wrapper (inside the border)
        var inputWrapper = document.getElementById('input-wrapper');
        if (inputWrapper) {
            inputWrapper.insertBefore(approvalModal, inputWrapper.firstChild);
        }
    }

    function createSettingsModal() {
        var settingsHost = document.getElementById('settings-tab-shell');
        if (!settingsHost) return;

        settingsModalOverlay = null;

        settingsModal = document.createElement('div');
        settingsModal.className = 'settings-tab-content';
        settingsModal.id = 'settings-modal';
        settingsModal.setAttribute('role', 'region');
        settingsModal.setAttribute('aria-labelledby', 'settings-modal-title');

        // Modal header
        var modalHeader = document.createElement('div');
        modalHeader.className = 'settings-modal-header';

        var titleSpan = document.createElement('span');
        titleSpan.className = 'settings-modal-title';
        titleSpan.id = 'settings-modal-title';
        titleSpan.textContent = 'Settings';
        modalHeader.appendChild(titleSpan);

        // Header buttons container
        var headerButtons = document.createElement('div');
        headerButtons.className = 'settings-modal-header-buttons';

        // Report Issue button
        var reportBtn = document.createElement('button');
        reportBtn.className = 'settings-modal-header-btn';
        reportBtn.innerHTML = '<span class="codicon codicon-report"></span>';
        reportBtn.title = 'Report Issue';
        reportBtn.setAttribute('aria-label', 'Report an issue on GitHub');
        reportBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'openExternal', url: 'https://github.com/intuitiv/TaskSync/issues/new' });
        });
        headerButtons.appendChild(reportBtn);

        settingsModalClose = null;

        modalHeader.appendChild(headerButtons);

        // Modal content
        var modalContent = document.createElement('div');
        modalContent.className = 'settings-modal-content';

        // Sound section - simplified, toggle right next to header
        var soundSection = document.createElement('div');
        soundSection.className = 'settings-section';
        soundSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title"><span class="codicon codicon-unmute"></span> Notifications</div>' +
            '<div class="toggle-switch active" id="sound-toggle" role="switch" aria-checked="true" aria-label="Enable notification sound" tabindex="0"></div>' +
            '</div>';
        modalContent.appendChild(soundSection);

        // Copilot Debug Logging — observability prerequisite (must be ON for Metrics to work),
        // so it sits above the Optimization group.
        var debugLoggingSection = document.createElement('div');
        debugLoggingSection.className = 'settings-section';
        debugLoggingSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title"><span class="codicon codicon-bug"></span> Copilot Debug Logging</div>' +
            '<div class="toggle-switch active" id="debug-logging-toggle" role="switch" aria-checked="true" aria-label="Enable Copilot debug logging" tabindex="0"></div>' +
            '</div>';
        modalContent.appendChild(debugLoggingSection);

        // Optimization controls
        var optimizationHeader = document.createElement('div');
        optimizationHeader.className = 'settings-section';
        optimizationHeader.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title" style="font-size:12px;opacity:0.6;text-transform:uppercase;letter-spacing:0.5px;"><span class="codicon codicon-graph"></span> Optimization</div>' +
            '</div>';
        modalContent.appendChild(optimizationHeader);

        var rtkSection = document.createElement('div');
        rtkSection.className = 'settings-section';
        rtkSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title"><span class="codicon codicon-server-process"></span> RTK Command Compression</div>' +
            '<div class="toggle-switch" id="rtk-compression-toggle" role="switch" aria-checked="false" aria-label="Enable RTK command compression" tabindex="0"></div>' +
            '</div>';
        modalContent.appendChild(rtkSection);

        // Disable Auto Compaction — inverts Copilot's summarizeAgentConversationHistory.enabled.
        // Checked = auto-compaction OFF (conversation history is not auto-summarized when the
        // context window fills). Sits in the Optimization group next to RTK.
        var autoCompactionSection = document.createElement('div');
        autoCompactionSection.className = 'settings-section';
        autoCompactionSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title">' +
            '<span class="codicon codicon-fold"></span> Disable Auto Compaction' +
            '<span class="settings-info-icon" title="When enabled, VS Code Copilot will NOT auto-compact (summarize) agent conversation history once the context window fills. Turns off github.copilot.chat.summarizeAgentConversationHistory.enabled.">' +
            '<span class="codicon codicon-info"></span></span>' +
            '</div>' +
            '<div class="toggle-switch" id="auto-compaction-toggle" role="switch" aria-checked="false" aria-label="Disable Copilot auto compaction" tabindex="0"></div>' +
            '</div>';
        modalContent.appendChild(autoCompactionSection);

        // Extended prompt-cache TTL — Anthropic 1-hour cache instead of the default ~5 min.
        // Directly buys more time before a cache goes cold (e.g. while composing a reply).
        var extendedTtlSection = document.createElement('div');
        extendedTtlSection.className = 'settings-section';
        extendedTtlSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title">' +
            '<span class="codicon codicon-clock"></span> Extended prompt cache (1 hour)' +
            '<span class="settings-info-icon" title="Enables Anthropic 1-hour prompt-cache TTL instead of the default ~5 minutes, so your cached context stays warm far longer (cache hits stay cheap). Sets github.copilot.chat.anthropic.promptCaching.extendedTtl (+ extendedTtlMessages). Requires a Claude model / plan that supports extended caching.">' +
            '<span class="codicon codicon-info"></span></span>' +
            '</div>' +
            '<div class="toggle-switch" id="extended-cache-ttl-toggle" role="switch" aria-checked="false" aria-label="Extended prompt cache TTL" tabindex="0"></div>' +
            '</div>' +
            '<div class="settings-subrow"><label for="extended-cache-ttl-messages-toggle" title="Also apply the 1-hour TTL to the conversation MESSAGES (the bulk of the tokens), not just the tool definitions. Sets github.copilot.chat.anthropic.promptCaching.extendedTtlMessages. Only takes effect when the Extended prompt cache toggle above is also ON (Copilot applies 1h to messages only when both flags are set).">Also extend messages (bulk)</label>' +
            '<div class="toggle-switch" id="extended-cache-ttl-messages-toggle" role="switch" aria-checked="false" aria-label="Extend messages TTL" tabindex="0"></div></div>';
        modalContent.appendChild(extendedTtlSection);

        // Keep cache warm during long sub-agent calls — native Copilot keep-alive probes.
        var keepWarmSection = document.createElement('div');
        keepWarmSection.className = 'settings-section';
        keepWarmSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title">' +
            '<span class="codicon codicon-pulse"></span> Keep cache warm (sub-agent probes)' +
            '<span class="settings-info-icon" title="Sends lightweight keep-alive probe requests (billed at the cheap cached-input rate) to preserve the prompt cache while a long sub-agent tool call runs. Sets github.copilot.chat.agent.longToolCallCachePreservation.enabled. Note: Copilot only probes during execution_subagent calls, not during ask_user waits.">' +
            '<span class="codicon codicon-info"></span></span>' +
            '</div>' +
            '<div class="toggle-switch" id="cache-keep-warm-toggle" role="switch" aria-checked="false" aria-label="Keep cache warm" tabindex="0"></div>' +
            '</div>' +
            '<div class="settings-subrow"><label for="cache-keep-warm-probes">Max probes</label>' +
            '<input type="number" id="cache-keep-warm-probes" min="0" max="10" step="1" class="settings-number-input" /></div>';
        modalContent.appendChild(keepWarmSection);
        var approvalSection = document.createElement('div');
        approvalSection.className = 'settings-section';
        approvalSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title"><span class="codicon codicon-checklist"></span> Interactive Approvals</div>' +
            '<div class="toggle-switch active" id="interactive-approval-toggle" role="switch" aria-checked="true" aria-label="Enable interactive approval and choice buttons" tabindex="0"></div>' +
            '</div>';

        // Send shortcut section - switch between Enter and Ctrl/Cmd+Enter send
        var sendShortcutSection = document.createElement('div');
        sendShortcutSection.className = 'settings-section';
        sendShortcutSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title"><span class="codicon codicon-keyboard"></span> Ctrl/Cmd+Enter to Send</div>' +
            '<div class="toggle-switch" id="send-shortcut-toggle" role="switch" aria-checked="false" aria-label="Use Ctrl/Cmd+Enter to send messages" tabindex="0"></div>' +
            '</div>';
        modalContent.appendChild(sendShortcutSection);

        // Turn budget (AIU) — soft per-turn credit limit the turn_budget tool checks against.
        var turnBudgetSection = document.createElement('div');
        turnBudgetSection.className = 'settings-section';
        turnBudgetSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title">' +
            '<span class="codicon codicon-credit-card"></span> Turn Budget (AIU)' +
            '<span class="settings-info-icon" title="Soft per-turn credit budget in AIU. When the agent calls the turn_budget tool and the turn spend exceeds this, it is advised to wrap up. 0 = disabled (no soft limit). Advisory only — nothing is blocked.">' +
            '<span class="codicon codicon-info"></span></span>' +
            '</div>' +
            '</div>' +
            '<div class="form-row">' +
            '<input type="number" class="form-input" id="turn-budget-input" min="0" max="1000000" step="100" placeholder="0 = disabled">' +
            '</div>';
        modalContent.appendChild(turnBudgetSection);

        // Autopilot section with cycling prompts list
        var autopilotSection = document.createElement('div');
        autopilotSection.className = 'settings-section';
        autopilotSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title">' +
            '<span class="codicon codicon-rocket"></span> Autopilot Prompts' +
            '<span class="settings-info-icon" title="Prompts cycle in order (1→2→3→1...) with human-like delay.\n\nHow it works:\n• The agent calls ask_user → Autopilot sends the next prompt in sequence\n• Add multiple prompts to alternate between different instructions\n• Drag to reorder, edit or delete individual prompts\n\nQueue Priority:\n• Queued prompts ALWAYS take priority over Autopilot\n• Autopilot only activates when the queue is empty">' +
            '<span class="codicon codicon-info"></span></span>' +
            '</div>' +
            '<button class="add-prompt-btn-inline" id="autopilot-add-btn" title="Add Autopilot prompt" aria-label="Add Autopilot prompt"><span class="codicon codicon-add"></span></button>' +
            '</div>' +
            '<div class="autopilot-prompts-list" id="autopilot-prompts-list"></div>' +
            '<div class="add-autopilot-prompt-form hidden" id="add-autopilot-prompt-form">' +
            '<div class="form-row">' +
            '<textarea class="form-input form-textarea" id="autopilot-prompt-input" placeholder="Enter Autopilot prompt text..." maxlength="2000"></textarea>' +
            '</div>' +
            '<div class="form-actions">' +
            '<button class="form-btn form-btn-cancel" id="cancel-autopilot-prompt-btn">Cancel</button>' +
            '<button class="form-btn form-btn-save" id="save-autopilot-prompt-btn">Save</button>' +
            '</div>' +
            '</div>';

        // Response Timeout section - dropdown for timeout minutes
        var timeoutSection = document.createElement('div');
        timeoutSection.className = 'settings-section';
        timeoutSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title">' +
            '<span class="codicon codicon-clock"></span> Response Timeout' +
            '<span class="settings-info-icon" title="If no response is received within this time, it will automatically send the session termination message.">' +
            '<span class="codicon codicon-info"></span></span>' +
            '</div>' +
            '</div>' +
            '<div class="form-row">' +
            '<select class="form-input form-select" id="response-timeout-select">' +
            '<option value="0">Disabled</option>' +
            '<option value="5">5 minutes</option>' +
            '<option value="10">10 minutes</option>' +
            '<option value="20">20 minutes</option>' +
            '<option value="30">30 minutes</option>' +
            '<option value="40">40 minutes</option>' +
            '<option value="50">50 minutes</option>' +
            '<option value="60">60 minutes (default)</option>' +
            '<option value="70">70 minutes</option>' +
            '<option value="80">80 minutes</option>' +
            '<option value="90">90 minutes</option>' +
            '<option value="100">100 minutes</option>' +
            '<option value="110">110 minutes</option>' +
            '<option value="120">120 minutes (2h)</option>' +
            '<option value="150">150 minutes (2.5h)</option>' +
            '<option value="180">180 minutes (3h)</option>' +
            '<option value="210">210 minutes (3.5h)</option>' +
            '<option value="240">240 minutes (4h)</option>' +
            '</select>' +
            '</div>';

        // Session Warning section - warning threshold in hours
        var sessionWarningSection = document.createElement('div');
        sessionWarningSection.className = 'settings-section';
        sessionWarningSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title">' +
            '<span class="codicon codicon-watch"></span> Session Warning' +
            '<span class="settings-info-icon" title="Show a one-time warning after this many hours in the same session. Set to 0 to disable.">' +
            '<span class="codicon codicon-info"></span></span>' +
            '</div>' +
            '</div>' +
            '<div class="form-row">' +
            '<select class="form-input form-select" id="session-warning-hours-select">' +
            '<option value="0">Disabled</option>' +
            '<option value="1">1 hour</option>' +
            '<option value="2">2 hours</option>' +
            '<option value="3">3 hours</option>' +
            '<option value="4">4 hours</option>' +
            '<option value="5">5 hours</option>' +
            '<option value="6">6 hours</option>' +
            '<option value="7">7 hours</option>' +
            '<option value="8">8 hours</option>' +
            '</select>' +
            '</div>';

        // Max Consecutive Auto-Responses section - number input
        var maxAutoSection = document.createElement('div');
        maxAutoSection.className = 'settings-section';
        maxAutoSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title">' +
            '<span class="codicon codicon-stop-circle"></span> Max Auto-Responses' +
            '<span class="settings-info-icon" title="Maximum consecutive auto-responses using Autopilot before pausing and requiring manual input. Prevents infinite loops.">' +
            '<span class="codicon codicon-info"></span></span>' +
            '</div>' +
            '</div>' +
            '<div class="form-row">' +
            '<input type="number" class="form-input" id="max-auto-responses-input" min="1" max="50" value="5" />' +
            '</div>';

        // Human-Like Delay section - toggle + min/max inputs
        var humanDelaySection = document.createElement('div');
        humanDelaySection.className = 'settings-section';
        humanDelaySection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title">' +
            '<span class="codicon codicon-pulse"></span> Human-Like Delay' +
            '<span class="settings-info-icon" title="Add random delays (2-6s by default) before auto-responses. Simulates natural pacing for automated responses.">' +
            '<span class="codicon codicon-info"></span></span>' +
            '</div>' +
            '<div class="toggle-switch active" id="human-delay-toggle" role="switch" aria-checked="true" aria-label="Toggle Human-Like Delay" tabindex="0"></div>' +
            '</div>' +
            '<div class="form-row human-delay-range" id="human-delay-range">' +
            '<label class="form-label-inline">Min (s):</label>' +
            '<input type="number" class="form-input form-input-small" id="human-delay-min-input" min="1" max="30" value="2" />' +
            '<label class="form-label-inline">Max (s):</label>' +
            '<input type="number" class="form-input form-input-small" id="human-delay-max-input" min="2" max="60" value="6" />' +
            '</div>';

        // Integrations header
        var integrationsHeader = document.createElement('div');
        integrationsHeader.className = 'settings-section';
        integrationsHeader.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title" style="font-size:12px;opacity:0.6;text-transform:uppercase;letter-spacing:0.5px;"><span class="codicon codicon-plug"></span> Integrations</div>' +
            '</div>';
        modalContent.appendChild(integrationsHeader);

        // Webex integration toggle
        var webexSection = document.createElement('div');
        webexSection.className = 'settings-section';
        webexSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title"><span class="codicon codicon-broadcast"></span> Webex</div>' +
            '<div class="toggle-switch" id="webex-toggle" role="switch" aria-checked="false" aria-label="Enable Webex integration" tabindex="0"></div>' +
            '</div>' +
            '<div class="settings-status" id="webex-status"></div>';
        modalContent.appendChild(webexSection);

        // Telegram integration toggle
        var telegramSection = document.createElement('div');
        telegramSection.className = 'settings-section';
        telegramSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title"><span class="codicon codicon-comment-discussion"></span> Telegram</div>' +
            '<div class="toggle-switch" id="telegram-toggle" role="switch" aria-checked="false" aria-label="Enable Telegram integration" tabindex="0"></div>' +
            '</div>' +
            '<div class="settings-status" id="telegram-status"></div>';
        modalContent.appendChild(telegramSection);

        // Reusable Prompts section - plus button next to title
        var promptsSection = document.createElement('div');
        promptsSection.className = 'settings-section';
        promptsSection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title"><span class="codicon codicon-symbol-keyword"></span> Reusable Prompts</div>' +
            '<button class="add-prompt-btn-inline" id="add-prompt-btn" title="Add Prompt" aria-label="Add reusable prompt"><span class="codicon codicon-add"></span></button>' +
            '</div>' +
            '<div class="prompts-list" id="prompts-list"></div>' +
            '<div class="add-prompt-form hidden" id="add-prompt-form">' +
            '<div class="form-row"><label class="form-label" for="prompt-name-input">Name (used as /command)</label>' +
            '<input type="text" class="form-input" id="prompt-name-input" placeholder="e.g., fix, test, refactor" maxlength="30"></div>' +
            '<div class="form-row"><label class="form-label" for="prompt-text-input">Prompt Text</label>' +
            '<textarea class="form-input form-textarea" id="prompt-text-input" placeholder="Enter the full prompt text..." maxlength="2000"></textarea></div>' +
            '<div class="form-actions">' +
            '<button class="form-btn form-btn-cancel" id="cancel-prompt-btn">Cancel</button>' +
            '<button class="form-btn form-btn-save" id="save-prompt-btn">Save</button></div></div>';

        // Assemble settings panel
        settingsModal.appendChild(modalHeader);
        settingsModal.appendChild(modalContent);
        settingsHost.innerHTML = '';
        settingsHost.appendChild(settingsModal);

        // Cache inner elements
        soundToggle = document.getElementById('sound-toggle');
        interactiveApprovalToggle = document.getElementById('interactive-approval-toggle');
        sendShortcutToggle = document.getElementById('send-shortcut-toggle');
        webexToggle = document.getElementById('webex-toggle');
        telegramToggle = document.getElementById('telegram-toggle');
        autopilotPromptsList = document.getElementById('autopilot-prompts-list');
        autopilotAddBtn = document.getElementById('autopilot-add-btn');
        addAutopilotPromptForm = document.getElementById('add-autopilot-prompt-form');
        autopilotPromptInput = document.getElementById('autopilot-prompt-input');
        saveAutopilotPromptBtn = document.getElementById('save-autopilot-prompt-btn');
        cancelAutopilotPromptBtn = document.getElementById('cancel-autopilot-prompt-btn');
        responseTimeoutSelect = document.getElementById('response-timeout-select');
        sessionWarningHoursSelect = document.getElementById('session-warning-hours-select');
        maxAutoResponsesInput = document.getElementById('max-auto-responses-input');
        turnBudgetInput = document.getElementById('turn-budget-input');
        humanDelayToggle = document.getElementById('human-delay-toggle');
        humanDelayRangeContainer = document.getElementById('human-delay-range');
        humanDelayMinInput = document.getElementById('human-delay-min-input');
        humanDelayMaxInput = document.getElementById('human-delay-max-input');
        promptsList = document.getElementById('prompts-list');
        addPromptBtn = document.getElementById('add-prompt-btn');
        addPromptForm = document.getElementById('add-prompt-form');
        debugLoggingToggle = document.getElementById('debug-logging-toggle');
        rtkCompressionToggle = document.getElementById('rtk-compression-toggle');
        autoCompactionToggle = document.getElementById('auto-compaction-toggle');
        extendedCacheTtlToggle = document.getElementById('extended-cache-ttl-toggle');
        extendedCacheTtlMessagesToggle = document.getElementById('extended-cache-ttl-messages-toggle');
        cacheKeepWarmToggle = document.getElementById('cache-keep-warm-toggle');
        cacheKeepWarmProbesInput = document.getElementById('cache-keep-warm-probes');
    }

    // Build the Observability ("Metrics") tab: the credits table, RTK/Gradle savings,
    // per-model + tool-call breakdowns, and the memories list. Kept separate from Settings.
    function createObservabilityTab() {
        var host = document.getElementById('observability-tab-shell');
        if (!host) return;

        var container = document.createElement('div');
        container.className = 'settings-tab-content';

        var header = document.createElement('div');
        header.className = 'settings-modal-header';
        var title = document.createElement('span');
        title.className = 'settings-modal-title';
        title.textContent = 'Observability';
        header.appendChild(title);
        container.appendChild(header);

        var content = document.createElement('div');
        content.className = 'settings-modal-content';

        var observabilitySection = document.createElement('div');
        observabilitySection.className = 'settings-section';
        observabilitySection.innerHTML = '<div class="settings-section-header">' +
            '<div class="settings-section-title"><span class="codicon codicon-pulse"></span> Observability</div>' +
            '</div>' +
            '<div class="obs-optimizations">' +
            '<div class="observability-rtk-line" id="observability-rtk-line">RTK: 0 calls \u00b7 0 saved \u00b7 0%</div>' +
            '<div class="observability-rtk-line" id="observability-gradle-line">Gradle: 0 runs \u00b7 0 optimized \u00b7 ~0 tokens saved</div>' +
            '</div>' +
            '<div class="obs-view-toggle">' +
            '<a href="#" id="obs-view-turn" class="obs-view-btn active">This turn</a>' +
            '<a href="#" id="obs-view-month" class="obs-view-btn">This month</a>' +
            '</div>' +
            // ── This turn: individual requests (growing) + this turn's tool calls ──
            '<div id="obs-turn-view">' +
            '<div class="obs-turn-summary" id="obs-turn-summary">No requests yet this turn</div>' +
            '<div class="obs-cache-row">' +
            '<div class="obs-cache-age" id="obs-cache-age" title="Time since the last model request. The prompt prefix cache stays warm for ~5 min; past that a new message likely incurs a cache MISS (more expensive). A long-running tool ages this clock too.">Prompt cache age: \u2013</div>' +
            '<button type="button" class="obs-cache-ping-btn" id="obs-cache-ping-btn" title="Keep-warm ping: fills the CURRENT chat input and submits it in the SAME agent/mode (identical system prompt \u2192 cache HIT at the cheap cached rate), refreshing the ~5-min TTL. Use it while the agent is idle and this chat is the active one. For automatic keep-warm, enable the native settings below (Keep cache warm + Extended prompt cache).">\u26a1 Ping</button>' +
            '</div>' +
            '<div class="observability-model-note">Timeline this turn \u2014 LLM requests in columns \u00b7 expand a tool row for input/output \u00b7 ask me to investigate any <b>ID</b></div>' +
            '<table class="observability-table observability-model-table obs-timeline-table">' +
            '<thead><tr><th>ID</th><th>Model / Tool</th><th>Credits</th><th>Input</th><th>Output</th><th>Cached</th><th title="cached / input">Hit%</th></tr></thead>' +
            '<tbody id="obs-turn-event-tbody"><tr><td colspan="7" class="obs-na">No events yet</td></tr></tbody>' +
            '</table>' +
            '<div class="observability-model-note">Tool calls this turn</div>' +
            '<table class="observability-table observability-model-table">' +
            '<thead><tr><th>Tool</th><th>Calls</th><th>Out tok</th><th>avg s</th><th>min s</th><th>max s</th><th>err</th></tr></thead>' +
            '<tbody id="obs-turn-tool-tbody"><tr><td colspan="7" class="obs-na">No data yet</td></tr></tbody>' +
            '</table>' +
            '</div>' +
            // ── This month: consolidated totals + per-model + this month's tool calls ──
            '<div id="obs-month-view" style="display:none">' +
            '<div class="observability-scope-note">Credits in AIU \u2014 current calendar month across all AskAway workspaces.</div>' +
            '<table class="observability-table">' +
            '<thead><tr><th>Reqs</th><th>Credits</th><th>Input</th><th>Output</th><th>Cached</th><th title="cached / input">Hit%</th><th title="requests with <50% cache">Miss</th></tr></thead>' +
            '<tbody><tr>' +
            '<td id="obs-all-reqs">0</td><td id="obs-all-credits">0</td><td id="obs-all-input">0</td><td id="obs-all-output">0</td><td id="obs-all-cached">0</td><td id="obs-all-hit">\u2013</td><td id="obs-all-miss">0</td>' +
            '</tr></tbody></table>' +
            '<div class="observability-scope-note" id="obs-all-compaction">Compaction: 0 requests</div>' +
            '<div class="observability-model-note">Per-model \u2014 this month</div>' +
            '<table class="observability-table observability-model-table">' +
            '<thead><tr><th>Model</th><th>Reqs</th><th>Credits</th><th>Input</th><th>Output</th><th>Cached</th></tr></thead>' +
            '<tbody id="observability-model-tbody"><tr><td colspan="6" class="obs-na">No data yet</td></tr></tbody>' +
            '</table>' +
            '<div class="observability-model-note">Tool calls this month</div>' +
            '<table class="observability-table observability-model-table">' +
            '<thead><tr><th>Tool</th><th>Calls</th><th>Out tok</th><th>avg s</th><th>min s</th><th>max s</th><th>err</th></tr></thead>' +
            '<tbody id="obs-month-tool-tbody"><tr><td colspan="7" class="obs-na">No data yet</td></tr></tbody>' +
            '</table>' +
            '</div>' +
            '<details class="settings-debug-details">' +
            '<summary>Debug Details</summary>' +
            '<div class="observability-grid debug-observability-grid">' +
            '<div class="observability-card"><div class="observability-label">Session Calls</div><div class="observability-value" id="observability-session-calls">0</div><div class="observability-subtext">Current AskAway exchange count</div></div>' +
            '<div class="observability-card"><div class="observability-label">Saved History</div><div class="observability-value" id="observability-history-count">0</div><div class="observability-subtext">Persisted conversation records</div></div>' +
            '<div class="observability-card"><div class="observability-label">Pending Commands</div><div class="observability-value" id="observability-pending-commands">0</div><div class="observability-subtext">Worker queue items waiting to run</div></div>' +
            '<div class="observability-card"><div class="observability-label">Pending Agents</div><div class="observability-value" id="observability-pending-agents">0</div><div class="observability-subtext">Research tasks waiting in queue</div></div>' +
            '<div class="observability-card"><div class="observability-label">Log Source</div><div class="observability-value" id="observability-source">unavailable</div><div class="observability-subtext">Latest debug-log session folder</div></div>' +
            '</div>' +
            '</details>' +
            '<details class="settings-debug-details" id="observability-memories-details">' +
            '<summary>Memories <span class="obs-mem-count" id="observability-memory-count">0</span></summary>' +
            '<div class="observability-model-note">Durable notes saved by sub-agents (shared memory store)</div>' +
            '<ul class="observability-memory-list" id="observability-memory-list"><li class="obs-na">No memories yet</li></ul>' +
            '</details>';
        content.appendChild(observabilitySection);
        container.appendChild(content);

        host.innerHTML = '';
        host.appendChild(container);

        // View toggle: turn ⇄ month drives the whole panel.
        var turnBtn = document.getElementById('obs-view-turn');
        var monthBtn = document.getElementById('obs-view-month');
        if (turnBtn) turnBtn.addEventListener('click', function (e) { e.preventDefault(); obsView = 'turn'; updateObservabilityUI(); });
        if (monthBtn) monthBtn.addEventListener('click', function (e) { e.preventDefault(); obsView = 'month'; updateObservabilityUI(); });

        // Cache observability element references now that they exist in the DOM.
        observabilitySessionCalls = document.getElementById('observability-session-calls');
        observabilityHistoryCount = document.getElementById('observability-history-count');
        observabilityPendingCommands = document.getElementById('observability-pending-commands');
        observabilityPendingAgents = document.getElementById('observability-pending-agents');
        observabilitySource = document.getElementById('observability-source');
        observabilityRtkLine = document.getElementById('observability-rtk-line');
        observabilityModelTbody = document.getElementById('observability-model-tbody');
        obsAllReqs = document.getElementById('obs-all-reqs');
        obsAllCredits = document.getElementById('obs-all-credits');
        observabilityMemoryList = document.getElementById('observability-memory-list');
        observabilityMemoryCount = document.getElementById('observability-memory-count');
    }

    function bindEventListeners() {
        if (chatInput) {
            chatInput.addEventListener('input', handleTextareaInput);
            chatInput.addEventListener('keydown', handleTextareaKeydown);
            chatInput.addEventListener('paste', handlePaste);
            // Sync scroll between textarea and highlighter
            chatInput.addEventListener('scroll', function () {
                if (inputHighlighter) {
                    inputHighlighter.scrollTop = chatInput.scrollTop;
                }
            });
        }
        if (sendBtn) sendBtn.addEventListener('click', handleSend);
        if (attachBtn) attachBtn.addEventListener('click', handleAttach);
        if (modeBtn) modeBtn.addEventListener('click', toggleModeDropdown);

        document.querySelectorAll('.mode-option[data-mode]').forEach(function (option) {
            option.addEventListener('click', function () {
                setMode(option.getAttribute('data-mode'), true);
                closeModeDropdown();
            });
        });

        document.addEventListener('click', function (e) {
            if (dropdownOpen && !e.target.closest('.mode-selector') && !e.target.closest('.mode-dropdown')) closeModeDropdown();
            if (autocompleteVisible && !e.target.closest('.autocomplete-dropdown') && !e.target.closest('#chat-input')) hideAutocomplete();
            if (slashDropdownVisible && !e.target.closest('.slash-dropdown') && !e.target.closest('#chat-input')) hideSlashDropdown();
        });

        if (queueHeader) queueHeader.addEventListener('click', handleQueueHeaderClick);
        if (historyModalClose) historyModalClose.addEventListener('click', closeHistoryModal);
        if (historyModalClearAll) historyModalClearAll.addEventListener('click', clearAllPersistedHistory);
        if (historyModalOverlay) {
            historyModalOverlay.addEventListener('click', function (e) {
                if (e.target === historyModalOverlay) closeHistoryModal();
            });
        }
        // Edit mode button events
        if (editCancelBtn) editCancelBtn.addEventListener('click', cancelEditMode);
        if (editConfirmBtn) editConfirmBtn.addEventListener('click', confirmEditMode);

        // Approval modal button events
        if (approvalContinueBtn) approvalContinueBtn.addEventListener('click', handleApprovalContinue);
        if (approvalNoBtn) approvalNoBtn.addEventListener('click', handleApprovalNo);

        // Settings modal events
        if (settingsModalClose) settingsModalClose.addEventListener('click', closeSettingsModal);
        if (settingsModalOverlay) {
            settingsModalOverlay.addEventListener('click', function (e) {
                if (e.target === settingsModalOverlay) closeSettingsModal();
            });
        }
        if (soundToggle) {
            soundToggle.addEventListener('click', toggleSoundSetting);
            soundToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleSoundSetting();
                }
            });
        }
        if (interactiveApprovalToggle) {
            interactiveApprovalToggle.addEventListener('click', toggleInteractiveApprovalSetting);
            interactiveApprovalToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleInteractiveApprovalSetting();
                }
            });
        }
        if (sendShortcutToggle) {
            sendShortcutToggle.addEventListener('click', toggleSendWithCtrlEnterSetting);
            sendShortcutToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleSendWithCtrlEnterSetting();
                }
            });
        }
        if (debugLoggingToggle) {
            debugLoggingToggle.addEventListener('click', toggleDebugLoggingSetting);
            debugLoggingToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleDebugLoggingSetting();
                }
            });
        }
        if (rtkCompressionToggle) {
            rtkCompressionToggle.addEventListener('click', toggleRtkCompressionSetting);
            rtkCompressionToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleRtkCompressionSetting();
                }
            });
        }
        if (autoCompactionToggle) {
            autoCompactionToggle.addEventListener('click', toggleAutoCompactionSetting);
            autoCompactionToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleAutoCompactionSetting();
                }
            });
        }
        if (extendedCacheTtlToggle) {
            extendedCacheTtlToggle.addEventListener('click', toggleExtendedCacheTtl);
            extendedCacheTtlToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExtendedCacheTtl(); }
            });
        }
        if (extendedCacheTtlMessagesToggle) {
            extendedCacheTtlMessagesToggle.addEventListener('click', toggleExtendedCacheTtlMessages);
            extendedCacheTtlMessagesToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExtendedCacheTtlMessages(); }
            });
        }
        if (cacheKeepWarmToggle) {
            cacheKeepWarmToggle.addEventListener('click', toggleCacheKeepWarm);
            cacheKeepWarmToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCacheKeepWarm(); }
            });
        }
        if (cacheKeepWarmProbesInput) {
            cacheKeepWarmProbesInput.addEventListener('change', function () {
                var v = Math.max(0, Math.min(10, Math.round(Number(cacheKeepWarmProbesInput.value) || 0)));
                cacheKeepWarmProbes = v;
                cacheKeepWarmProbesInput.value = String(v);
                vscode.postMessage({ type: 'updateCacheKeepWarmProbes', value: v });
            });
        }
        if (webexToggle) {
            webexToggle.addEventListener('click', toggleWebexSetting);
            webexToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleWebexSetting();
                }
            });
        }
        if (telegramToggle) {
            telegramToggle.addEventListener('click', toggleTelegramSetting);
            telegramToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleTelegramSetting();
                }
            });
        }
        if (autopilotToggle) {
            autopilotToggle.addEventListener('click', toggleAutopilotSetting);
            autopilotToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleAutopilotSetting();
                }
            });
        }
        // Autopilot prompts list event listeners
        if (autopilotAddBtn) {
            autopilotAddBtn.addEventListener('click', showAddAutopilotPromptForm);
        }
        if (saveAutopilotPromptBtn) {
            saveAutopilotPromptBtn.addEventListener('click', saveAutopilotPrompt);
        }
        if (cancelAutopilotPromptBtn) {
            cancelAutopilotPromptBtn.addEventListener('click', hideAddAutopilotPromptForm);
        }
        if (autopilotPromptsList) {
            autopilotPromptsList.addEventListener('click', handleAutopilotPromptsListClick);
            // Drag and drop for reordering
            autopilotPromptsList.addEventListener('dragstart', handleAutopilotDragStart);
            autopilotPromptsList.addEventListener('dragover', handleAutopilotDragOver);
            autopilotPromptsList.addEventListener('dragend', handleAutopilotDragEnd);
            autopilotPromptsList.addEventListener('drop', handleAutopilotDrop);
        }
        if (responseTimeoutSelect) {
            responseTimeoutSelect.addEventListener('change', handleResponseTimeoutChange);
        }
        if (sessionWarningHoursSelect) {
            sessionWarningHoursSelect.addEventListener('change', handleSessionWarningHoursChange);
        }
        if (maxAutoResponsesInput) {
            maxAutoResponsesInput.addEventListener('change', handleMaxAutoResponsesChange);
            maxAutoResponsesInput.addEventListener('blur', handleMaxAutoResponsesChange);
        }
        if (turnBudgetInput) {
            turnBudgetInput.addEventListener('change', handleTurnBudgetChange);
            turnBudgetInput.addEventListener('blur', handleTurnBudgetChange);
        }
        if (humanDelayToggle) {
            humanDelayToggle.addEventListener('click', toggleHumanDelaySetting);
            humanDelayToggle.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleHumanDelaySetting();
                }
            });
        }
        if (humanDelayMinInput) {
            humanDelayMinInput.addEventListener('change', handleHumanDelayMinChange);
            humanDelayMinInput.addEventListener('blur', handleHumanDelayMinChange);
        }
        if (humanDelayMaxInput) {
            humanDelayMaxInput.addEventListener('change', handleHumanDelayMaxChange);
            humanDelayMaxInput.addEventListener('blur', handleHumanDelayMaxChange);
        }
        if (addPromptBtn) addPromptBtn.addEventListener('click', showAddPromptForm);
        // Add prompt form events (deferred - bind after modal created)
        var cancelPromptBtn = document.getElementById('cancel-prompt-btn');
        var savePromptBtn = document.getElementById('save-prompt-btn');
        if (cancelPromptBtn) cancelPromptBtn.addEventListener('click', hideAddPromptForm);
        if (savePromptBtn) savePromptBtn.addEventListener('click', saveNewPrompt);

        // Context menu and copy handling
        document.addEventListener('contextmenu', handleContextMenu);
        document.addEventListener('copy', handleCopy);

        window.addEventListener('message', handleExtensionMessage);
    }

    function openHistoryModal() {
        if (!historyModalOverlay) return;
        // Request persisted history from extension
        vscode.postMessage({ type: 'openHistoryModal' });
        historyModalOverlay.classList.remove('hidden');
    }

    function closeHistoryModal() {
        if (!historyModalOverlay) return;
        historyModalOverlay.classList.add('hidden');
    }

    function clearAllPersistedHistory() {
        if (persistedHistory.length === 0) return;
        vscode.postMessage({ type: 'clearPersistedHistory' });
        persistedHistory = [];
        renderHistoryModal();
    }

    function initCardSelection() {
        if (cardVibe) {
            cardVibe.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                selectCard('normal', true);
            });
        }
        if (cardSpec) {
            cardSpec.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                selectCard('queue', true);
            });
        }
        var cardPlan = document.getElementById('card-plan');
        if (cardPlan) {
            cardPlan.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                selectCard('plan', true);
            });
        }
        // Don't set default here - wait for updateQueue message from extension
        // which contains the persisted enabled state
        updateCardSelection();
    }

    function selectCard(card, notify) {
        selectedCard = card;
        queueEnabled = card === 'queue';
        planEnabled = card === 'plan';
        updateCardSelection();
        updateModeUI();
        updateQueueVisibility();
        updatePlanBoardVisibility();

        // Only notify extension if user clicked (not on init from persisted state)
        if (notify) {
            if (planEnabled) {
                vscode.postMessage({ type: 'planSetMode', enabled: true });
                // Plan mode uses the queue to feed tasks to Copilot — keep it enabled
                vscode.postMessage({ type: 'toggleQueue', enabled: true });
            } else {
                vscode.postMessage({ type: 'planSetMode', enabled: false });
                vscode.postMessage({ type: 'toggleQueue', enabled: queueEnabled });
            }
        }
    }

    function updateCardSelection() {
        // card-vibe = Normal mode, card-spec = Queue mode, card-plan = Plan mode
        if (cardVibe) cardVibe.classList.toggle('selected', selectedCard === 'normal');
        if (cardSpec) cardSpec.classList.toggle('selected', selectedCard === 'queue');
        var cardPlan = document.getElementById('card-plan');
        if (cardPlan) cardPlan.classList.toggle('selected', selectedCard === 'plan');
    }

    function autoResizeTextarea() {
        if (!chatInput) return;
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
    }

    /**
     * Update the input highlighter overlay to show syntax highlighting
     * for slash commands (/command) and file references (#file)
     */
    function updateInputHighlighter() {
        if (!inputHighlighter || !chatInput) return;

        var text = chatInput.value;
        if (!text) {
            inputHighlighter.innerHTML = '';
            return;
        }

        // Build a list of known slash command names for exact matching
        var knownSlashNames = reusablePrompts.map(function (p) { return p.name; });
        // Also add any pending stored mappings
        var mappings = chatInput._slashPrompts || {};
        Object.keys(mappings).forEach(function (name) {
            if (knownSlashNames.indexOf(name) === -1) knownSlashNames.push(name);
        });

        // Escape HTML first
        var html = escapeHtml(text);

        // Highlight slash commands - match /word patterns
        // Only highlight if it's a known command OR any /word pattern
        html = html.replace(/(^|\s)(\/[a-zA-Z0-9_-]+)(\s|$)/g, function (match, before, slash, after) {
            var cmdName = slash.substring(1); // Remove the /
            // Highlight if it's a known command or if we have prompts defined
            if (knownSlashNames.length === 0 || knownSlashNames.indexOf(cmdName) >= 0) {
                return before + '<span class="slash-highlight">' + slash + '</span>' + after;
            }
            // Still highlight as generic slash command
            return before + '<span class="slash-highlight">' + slash + '</span>' + after;
        });

        // Highlight file references - match #word patterns
        html = html.replace(/(^|\s)(#[a-zA-Z0-9_.\/-]+)(\s|$)/g, function (match, before, hash, after) {
            return before + '<span class="hash-highlight">' + hash + '</span>' + after;
        });

        // Don't add trailing space - causes visual artifacts
        // html += '&nbsp;';

        inputHighlighter.innerHTML = html;

        // Sync scroll position
        inputHighlighter.scrollTop = chatInput.scrollTop;
    }

    function handleTextareaInput() {
        autoResizeTextarea();
        updateInputHighlighter();
        handleAutocomplete();
        handleSlashCommands();
        // Context items (#terminal, #problems) now handled via handleAutocomplete()
        syncAttachmentsWithText();
        updateSendButtonState();
        // Persist input value so it survives sidebar tab switches
        saveWebviewState();
    }

    function updateSendButtonState() {
        if (!sendBtn || !chatInput) return;
        var hasText = chatInput.value.trim().length > 0;
        sendBtn.classList.toggle('has-text', hasText);
    }

    function handleTextareaKeydown(e) {
        // Handle approval modal keyboard shortcuts when visible
        if (isApprovalQuestion && approvalModal && !approvalModal.classList.contains('hidden')) {
            // Enter sends "Continue" when approval modal is visible and input is empty
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                var inputText = chatInput ? chatInput.value.trim() : '';
                if (!inputText) {
                    e.preventDefault();
                    handleApprovalContinue();
                    return;
                }
                // If there's text, fall through to normal send behavior
            }
            // Escape dismisses approval modal
            if (e.key === 'Escape') {
                e.preventDefault();
                handleApprovalNo();
                return;
            }
        }

        // Handle edit mode keyboard shortcuts
        if (editingPromptId) {
            if (e.key === 'Escape') {
                e.preventDefault();
                cancelEditMode();
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                confirmEditMode();
                return;
            }
            // Allow other keys in edit mode
            return;
        }

        // Handle slash command dropdown navigation
        if (slashDropdownVisible) {
            if (e.key === 'ArrowDown') { e.preventDefault(); if (selectedSlashIndex < slashResults.length - 1) { selectedSlashIndex++; updateSlashSelection(); } return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); if (selectedSlashIndex > 0) { selectedSlashIndex--; updateSlashSelection(); } return; }
            if ((e.key === 'Enter' || e.key === 'Tab') && selectedSlashIndex >= 0) { e.preventDefault(); selectSlashItem(selectedSlashIndex); return; }
            if (e.key === 'Escape') { e.preventDefault(); hideSlashDropdown(); return; }
        }

        if (autocompleteVisible) {
            if (e.key === 'ArrowDown') { e.preventDefault(); if (selectedAutocompleteIndex < autocompleteResults.length - 1) { selectedAutocompleteIndex++; updateAutocompleteSelection(); } return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); if (selectedAutocompleteIndex > 0) { selectedAutocompleteIndex--; updateAutocompleteSelection(); } return; }
            if ((e.key === 'Enter' || e.key === 'Tab') && selectedAutocompleteIndex >= 0) { e.preventDefault(); selectAutocompleteItem(selectedAutocompleteIndex); return; }
            if (e.key === 'Escape') { e.preventDefault(); hideAutocomplete(); return; }
        }

        // Context dropdown navigation removed - context now uses # via file autocomplete

        var isPlainEnter = e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey;
        var isCtrlOrCmdEnter = e.key === 'Enter' && !e.shiftKey && (e.ctrlKey || e.metaKey);

        if (!sendWithCtrlEnter && isPlainEnter) {
            e.preventDefault();
            handleSend();
            return;
        }

        if (sendWithCtrlEnter && isCtrlOrCmdEnter) {
            e.preventDefault();
            handleSend();
            return;
        }
    }

    function handleSend() {
        var text = chatInput ? chatInput.value.trim() : '';
        if (!text && currentAttachments.length === 0) return;

        // Expand slash commands to full prompt text
        text = expandSlashCommands(text);

        // Hide approval modal when sending any response
        hideApprovalModal();

        // If processing response (AI working), auto-queue the message
        if (isProcessingResponse && text) {
            addToQueue(text);
            // This reduces friction - user's prompt is in queue, so show them queue mode
            if (!queueEnabled) {
                queueEnabled = true;
                updateModeUI();
                updateQueueVisibility();
                updateCardSelection();
                vscode.postMessage({ type: 'toggleQueue', enabled: true });
            }
            if (chatInput) {
                chatInput.value = '';
                chatInput.style.height = 'auto';
                updateInputHighlighter();
            }
            currentAttachments = [];
            updateChipsDisplay();
            updateSendButtonState();
            // Clear persisted state after sending
            saveWebviewState();
            return;
        }

        if (queueEnabled && text && !pendingToolCall) {
            addToQueue(text);
        } else {
            vscode.postMessage({ type: 'submit', value: text, attachments: currentAttachments });
        }

        if (chatInput) {
            chatInput.value = '';
            chatInput.style.height = 'auto';
            updateInputHighlighter();
        }
        currentAttachments = [];
        updateChipsDisplay();
        updateSendButtonState();
        // Clear persisted state after sending
        saveWebviewState();
    }

    function handleAttach() { vscode.postMessage({ type: 'addAttachment' }); }

    function toggleModeDropdown(e) {
        e.stopPropagation();
        if (dropdownOpen) closeModeDropdown();
        else {
            dropdownOpen = true;
            positionModeDropdown();
            modeDropdown.classList.remove('hidden');
            modeDropdown.classList.add('visible');
        }
    }

    function positionModeDropdown() {
        if (!modeDropdown || !modeBtn) return;
        var rect = modeBtn.getBoundingClientRect();
        modeDropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        modeDropdown.style.left = rect.left + 'px';
    }

    function closeModeDropdown() {
        dropdownOpen = false;
        if (modeDropdown) {
            modeDropdown.classList.remove('visible');
            modeDropdown.classList.add('hidden');
        }
    }

    function setMode(mode, notify) {
        queueEnabled = mode === 'queue';
        planEnabled = mode === 'plan';
        selectedCard = mode;
        updateModeUI();
        updateQueueVisibility();
        updateCardSelection();
        updatePlanBoardVisibility();
        if (notify) {
            if (planEnabled) {
                vscode.postMessage({ type: 'planSetMode', enabled: true });
                // Plan mode uses the queue to feed tasks to Copilot — keep it enabled
                vscode.postMessage({ type: 'toggleQueue', enabled: true });
            } else {
                vscode.postMessage({ type: 'planSetMode', enabled: false });
                vscode.postMessage({ type: 'toggleQueue', enabled: queueEnabled });
            }
        }
    }

    function updateModeUI() {
        var label = planEnabled ? 'Plan (Experimental)' : (queueEnabled ? 'Queue' : 'Normal');
        if (modeLabel) modeLabel.textContent = label;
        document.querySelectorAll('.mode-option[data-mode]').forEach(function (opt) {
            var m = opt.getAttribute('data-mode');
            opt.classList.toggle('selected', m === (planEnabled ? 'plan' : (queueEnabled ? 'queue' : 'normal')));
        });
    }

    function updateQueueVisibility() {
        if (!queueSection) return;
        // Hide queue section if: not in queue mode OR queue is empty
        var shouldHide = !queueEnabled || promptQueue.length === 0;
        var wasHidden = queueSection.classList.contains('hidden');
        queueSection.classList.toggle('hidden', shouldHide);
        // Only collapse when showing for the FIRST time (was hidden, now visible)
        // Don't collapse on subsequent updates to preserve user's expanded state
        if (wasHidden && !shouldHide && promptQueue.length > 0) {
            queueSection.classList.add('collapsed');
        }
    }

    function handleQueueHeaderClick() {
        if (queueSection) queueSection.classList.toggle('collapsed');
    }

    function handleExtensionMessage(event) {
        var message = event.data;
        console.log('[TaskSync Webview] Received message:', message.type, message);
        switch (message.type) {
            case 'updateQueue':
                promptQueue = message.queue || [];
                queueEnabled = message.enabled !== false;
                renderQueue();
                updateModeUI();
                updateQueueVisibility();
                updateCardSelection();
                // Hide welcome section if we have current session calls
                updateWelcomeSectionVisibility();
                break;
            case 'toolCallPending':
                console.log('[TaskSync Webview] toolCallPending - showing question:', message.prompt?.substring(0, 50));
                showPendingToolCall(message.id, message.prompt, message.isApprovalQuestion, message.choices);
                break;
            case 'toolCallCompleted':
                addToolCallToCurrentSession(message.entry);
                break;
            case 'updateCurrentSession':
                currentSessionCalls = message.history || [];
                renderCurrentSession();
                updateObservabilityUI();
                // Hide welcome section if we have completed tool calls
                updateWelcomeSectionVisibility();
                // Auto-scroll to bottom after rendering
                scrollToBottom();
                break;
            case 'updatePersistedHistory':
                persistedHistory = message.history || [];
                renderHistoryModal();
                updateObservabilityUI();
                break;
            case 'openHistoryModal':
                openHistoryModal();
                break;
            case 'openSettingsModal':
                openSettingsModal();
                break;
            case 'updateSettings':
                soundEnabled = message.soundEnabled !== false;
                interactiveApprovalEnabled = message.interactiveApprovalEnabled !== false;
                sendWithCtrlEnter = message.sendWithCtrlEnter === true;
                webexEnabled = message.webexEnabled === true;
                telegramEnabled = message.telegramEnabled === true;
                autopilotEnabled = message.autopilotEnabled === true;
                autopilotText = typeof message.autopilotText === 'string' ? message.autopilotText : '';
                autopilotPrompts = Array.isArray(message.autopilotPrompts) ? message.autopilotPrompts : [];
                reusablePrompts = message.reusablePrompts || [];
                responseTimeout = normalizeResponseTimeout(message.responseTimeout);
                sessionWarningHours = typeof message.sessionWarningHours === 'number' ? message.sessionWarningHours : 2;
                maxConsecutiveAutoResponses = typeof message.maxConsecutiveAutoResponses === 'number' ? message.maxConsecutiveAutoResponses : 5;
                turnBudgetAiu = typeof message.turnBudgetAiu === 'number' ? message.turnBudgetAiu : 0;
                humanLikeDelayEnabled = message.humanLikeDelayEnabled !== false;
                humanLikeDelayMin = typeof message.humanLikeDelayMin === 'number' ? message.humanLikeDelayMin : 2;
                humanLikeDelayMax = typeof message.humanLikeDelayMax === 'number' ? message.humanLikeDelayMax : 6;
                debugLoggingEnabled = message.debugLoggingEnabled !== false;
                rtkCompressionEnabled = message.rtkCompressionEnabled === true;
                rtkInstalled = message.rtkInstalled !== false;
                autoCompactionDisabled = message.autoCompactionDisabled === true;
                extendedCacheTtl = message.extendedCacheTtl === true;
                extendedCacheTtlMessages = message.extendedCacheTtlMessages === true;
                cacheKeepWarmEnabled = message.cacheKeepWarmEnabled === true;
                cacheKeepWarmProbes = Number(message.cacheKeepWarmProbes);
                if (!isFinite(cacheKeepWarmProbes)) { cacheKeepWarmProbes = 1; }
                if (message.observabilityMetrics && typeof message.observabilityMetrics === 'object') {
                    observabilityMetrics = {
                        requestCount: Number(message.observabilityMetrics.requestCount) || 0,
                        inputTokens: Number(message.observabilityMetrics.inputTokens) || 0,
                        outputTokens: Number(message.observabilityMetrics.outputTokens) || 0,
                        cachedTokens: Number(message.observabilityMetrics.cachedTokens) || 0,
                        nanoAiu: Number(message.observabilityMetrics.nanoAiu) || 0,
                        rtkCommandCount: Number(message.observabilityMetrics.rtkCommandCount) || 0,
                        rtkSavedTokens: Number(message.observabilityMetrics.rtkSavedTokens) || 0,
                        rtkSavingsPct: Number(message.observabilityMetrics.rtkSavingsPct) || 0,
                        source: typeof message.observabilityMetrics.source === 'string' ? message.observabilityMetrics.source : 'unavailable',
                        updatedAt: Number(message.observabilityMetrics.updatedAt) || 0
                    };
                }
                updateSoundToggleUI();
                updateInteractiveApprovalToggleUI();
                updateSendWithCtrlEnterToggleUI();
                updateDebugLoggingToggleUI();
                updateRtkCompressionToggleUI();
                updateAutoCompactionToggleUI();
                updateCacheSettingsUI();
                updateWebexToggleUI();
                updateWebexStatusUI(message.webexStatus);
                updateTelegramToggleUI();
                updateTelegramStatusUI(message.telegramStatus);
                updateAutopilotToggleUI();
                renderAutopilotPromptsList();
                updateResponseTimeoutUI();
                updateSessionWarningHoursUI();
                updateMaxAutoResponsesUI();
                updateTurnBudgetUI();
                updateHumanDelayUI();
                renderPromptsList();
                updateObservabilityUI();
                break;
            case 'updateObservabilityMetrics':
                if (message.metrics && typeof message.metrics === 'object') {
                    var sanitizeScope = function (s) {
                        s = s || {};
                        return {
                            requestCount: Number(s.requestCount) || 0,
                            inputTokens: Number(s.inputTokens) || 0,
                            outputTokens: Number(s.outputTokens) || 0,
                            cachedTokens: Number(s.cachedTokens) || 0,
                            nanoAiu: Number(s.nanoAiu) || 0,
                            cacheMisses: Number(s.cacheMisses) || 0
                        };
                    };
                    observabilityMetrics = {
                        requestCount: Number(message.metrics.requestCount) || 0,
                        inputTokens: Number(message.metrics.inputTokens) || 0,
                        outputTokens: Number(message.metrics.outputTokens) || 0,
                        cachedTokens: Number(message.metrics.cachedTokens) || 0,
                        nanoAiu: Number(message.metrics.nanoAiu) || 0,
                        lastRequest: sanitizeScope(message.metrics.lastRequest),
                        workspace: sanitizeScope(message.metrics.workspace),
                        overall: sanitizeScope(message.metrics.overall),
                        overallCompaction: (function (c) {
                            c = c || {};
                            return { count: Number(c.count) || 0, nanoAiu: Number(c.nanoAiu) || 0 };
                        })(message.metrics.overallCompaction),
                        perModel: Array.isArray(message.metrics.perModel) ? message.metrics.perModel.map(function (m) {
                            var sc = sanitizeScope(m);
                            sc.model = typeof m.model === 'string' ? m.model : 'unknown';
                            return sc;
                        }) : [],
                        turnRequests: Array.isArray(message.metrics.turnRequests) ? message.metrics.turnRequests.map(function (r) {
                            return {
                                id: typeof r.id === 'string' ? r.id : '?????',
                                model: typeof r.model === 'string' ? r.model : 'unknown',
                                nanoAiu: Number(r.nanoAiu) || 0,
                                inputTokens: Number(r.inputTokens) || 0,
                                outputTokens: Number(r.outputTokens) || 0,
                                cachedTokens: Number(r.cachedTokens) || 0,
                                cacheHitPct: Number(r.cacheHitPct) || 0,
                                kindTag: typeof r.kindTag === 'string' ? r.kindTag : 'normal',
                                subagent: (typeof r.subagent === 'string' && r.subagent) ? r.subagent : null
                            };
                        }) : [],
                        turnEvents: Array.isArray(message.metrics.turnEvents) ? message.metrics.turnEvents.map(function (event) {
                            if (event && event.kind === 'tool') {
                                return {
                                    kind: 'tool',
                                    id: typeof event.id === 'string' ? event.id : '?????',
                                    tool: typeof event.tool === 'string' ? event.tool : 'unknown',
                                    status: typeof event.status === 'string' ? event.status : 'ok',
                                    durMs: Number(event.durMs) || 0,
                                    inputTokens: Number(event.inputTokens) || 0,
                                    outputTokens: Number(event.outputTokens) || 0,
                                    group: typeof event.group === 'string' ? event.group : 'default',
                                    inputPreview: typeof event.inputPreview === 'string' ? event.inputPreview : '',
                                    outputPreview: typeof event.outputPreview === 'string' ? event.outputPreview : '',
                                    subagent: (typeof event.subagent === 'string' && event.subagent) ? event.subagent : null,
                                    subagentId: (typeof event.subagentId === 'string' && event.subagentId) ? event.subagentId : null
                                };
                            }
                            return {
                                kind: 'request',
                                id: event && typeof event.id === 'string' ? event.id : '?????',
                                model: event && typeof event.model === 'string' ? event.model : 'unknown',
                                nanoAiu: Number(event && event.nanoAiu) || 0,
                                inputTokens: Number(event && event.inputTokens) || 0,
                                outputTokens: Number(event && event.outputTokens) || 0,
                                cachedTokens: Number(event && event.cachedTokens) || 0,
                                cacheHitPct: Number(event && event.cacheHitPct) || 0,
                                kindTag: (event && typeof event.kindTag === 'string') ? event.kindTag : 'normal',
                                subagent: (event && typeof event.subagent === 'string' && event.subagent) ? event.subagent : null,
                                subagentId: (event && typeof event.subagentId === 'string' && event.subagentId) ? event.subagentId : null,
                                firstOfTurn: !!(event && event.firstOfTurn),
                                split: (event && event.split && typeof event.split === 'object') ? {
                                    systemTokens: Number(event.split.systemTokens) || 0,
                                    toolsTokens: Number(event.split.toolsTokens) || 0,
                                    conversationTokens: Number(event.split.conversationTokens) || 0,
                                    newMessageTokens: Number(event.split.newMessageTokens) || 0,
                                    cachedPriorTokens: Number(event.split.cachedPriorTokens) || 0,
                                    userTokens: Number(event.split.userTokens) || 0,
                                    totalInputTokens: Number(event.split.totalInputTokens) || 0,
                                    skillsCount: Number(event.split.skillsCount) || 0,
                                    toolsCount: Number(event.split.toolsCount) || 0,
                                    messageCount: Number(event.split.messageCount) || 0,
                                    cachedTokens: Number(event.split.cachedTokens) || 0,
                                    composition: (event.split.composition && typeof event.split.composition === 'object') ? {
                                        totalTokens: Number(event.split.composition.totalTokens) || 0,
                                        baseTokens: Number(event.split.composition.baseTokens) || 0,
                                        segments: Array.isArray(event.split.composition.segments) ? event.split.composition.segments.map(function (s) {
                                            return {
                                                label: typeof s.label === 'string' ? s.label : '',
                                                kind: typeof s.kind === 'string' ? s.kind : 'attachment',
                                                path: (typeof s.path === 'string' && s.path) ? s.path : null,
                                                workspaceFolder: (typeof s.workspaceFolder === 'string' && s.workspaceFolder) ? s.workspaceFolder : null,
                                                tokens: Number(s.tokens) || 0,
                                                children: Array.isArray(s.children) ? s.children.map(function (c) {
                                                    return {
                                                        label: typeof c.label === 'string' ? c.label : '',
                                                        path: (typeof c.path === 'string' && c.path) ? c.path : null,
                                                        tokens: Number(c.tokens) || 0
                                                    };
                                                }) : null
                                            };
                                        }) : []
                                    } : null,
                                    contributors: (event.split.contributors && typeof event.split.contributors === 'object') ? {
                                        totalInputTokens: Number(event.split.contributors.totalInputTokens) || 0,
                                        cachedTokens: Number(event.split.contributors.cachedTokens) || 0,
                                        accountedTokens: Number(event.split.contributors.accountedTokens) || 0,
                                        items: Array.isArray(event.split.contributors.items) ? event.split.contributors.items.map(function (it) {
                                            return {
                                                label: typeof it.label === 'string' ? it.label : '',
                                                kind: typeof it.kind === 'string' ? it.kind : 'dialogue',
                                                tokens: Number(it.tokens) || 0,
                                                path: (typeof it.path === 'string' && it.path) ? it.path : null,
                                                count: Number(it.count) || 0
                                            };
                                        }) : [],
                                        files: Array.isArray(event.split.contributors.files) ? event.split.contributors.files.filter(function (f) { return typeof f === 'string'; }) : [],
                                        memoryFiles: Array.isArray(event.split.contributors.memoryFiles) ? event.split.contributors.memoryFiles.filter(function (f) { return typeof f === 'string'; }) : []
                                    } : null
                                } : null
                            };
                        }) : [],
                        turnSubagents: Array.isArray(message.metrics.turnSubagents) ? message.metrics.turnSubagents.map(function (s) {
                            return {
                                subagentId: typeof s.subagentId === 'string' ? s.subagentId : '',
                                label: typeof s.label === 'string' ? s.label : 'sub-agent',
                                done: !!s.done,
                                durMs: Number(s.durMs) || 0,
                                outputTokens: Number(s.outputTokens) || 0,
                                status: typeof s.status === 'string' ? s.status : 'running'
                            };
                        }) : [],
                        rtkCommandCount: Number(message.metrics.rtkCommandCount) || 0,
                        rtkSavedTokens: Number(message.metrics.rtkSavedTokens) || 0,
                        rtkSavingsPct: Number(message.metrics.rtkSavingsPct) || 0,
                        lastRequestTs: Number(message.metrics.lastRequestTs) || 0,
                        gradle: (function (g) {
                            g = g || {};
                            return {
                                runs: Number(g.runs) || 0,
                                optimizedRuns: Number(g.optimizedRuns) || 0,
                                tasksAvoided: Number(g.tasksAvoided) || 0,
                                configCacheReuses: Number(g.configCacheReuses) || 0,
                                savedTokens: Number(g.savedTokens) || 0
                            };
                        })(message.metrics.gradle),
                        toolCalls: (function (t) {
                            t = t || {};
                            function mapScope(s) {
                                s = s || {};
                                return {
                                    totalCalls: Number(s.totalCalls) || 0,
                                    totalOutputTokens: Number(s.totalOutputTokens) || 0,
                                    byTool: Array.isArray(s.byTool) ? s.byTool.map(function (r) {
                                        return {
                                            tool: typeof r.tool === 'string' ? r.tool : 'unknown',
                                            calls: Number(r.calls) || 0,
                                            outputTokens: Number(r.outputTokens) || 0,
                                            avgMs: Number(r.avgMs) || 0,
                                            minMs: Number(r.minMs) || 0,
                                            maxMs: Number(r.maxMs) || 0,
                                            errors: Number(r.errors) || 0,
                                            cacheRisk: !!r.cacheRisk,
                                            groups: Array.isArray(r.groups) ? r.groups.map(function (gg) {
                                                return { group: typeof gg.group === 'string' ? gg.group : '?', calls: Number(gg.calls) || 0 };
                                            }) : []
                                        };
                                    }) : []
                                };
                            }
                            var month = mapScope(t);
                            month.turn = mapScope(t.turn);
                            return month;
                        })(message.metrics.toolCalls),
                        source: typeof message.metrics.source === 'string' ? message.metrics.source : 'unavailable',
                        updatedAt: Number(message.metrics.updatedAt) || 0
                    };
                }
                updateObservabilityUI();
                break;
            case 'updateMemoriesList':
                memoriesList = Array.isArray(message.memories) ? message.memories : [];
                renderMemoriesList();
                break;
            case 'slashCommandResults':
                showSlashDropdown(message.prompts || []);
                break;
            case 'playNotificationSound':
                playNotificationSound();
                break;
            case 'fileSearchResults':
                showAutocomplete(message.files || []);
                break;
            case 'updateAttachments':
                currentAttachments = message.attachments || [];
                updateChipsDisplay();
                break;
            case 'imageSaved':
                if (message.attachment && !currentAttachments.some(function (a) { return a.id === message.attachment.id; })) {
                    currentAttachments.push(message.attachment);
                    updateChipsDisplay();
                }
                break;
            case 'clear':
                promptQueue = [];
                currentSessionCalls = [];
                pendingToolCall = null;
                isProcessingResponse = false;
                renderQueue();
                renderCurrentSession();
                if (pendingMessage) {
                    pendingMessage.classList.add('hidden');
                    pendingMessage.innerHTML = '';
                }
                updateWelcomeSectionVisibility();
                break;
            case 'updateSessionTimer':
                // Timer is displayed in the view title bar by the extension host
                // No webview UI to update
                break;
            case 'triggerSendFromShortcut':
                handleSendFromShortcut();
                break;
            case 'voiceStart':
                handleVoiceStart(message.taskId, message.question);
                break;
            case 'voiceSpeakingDone':
                handleVoiceSpeakingDone(message.taskId);
                break;
            case 'voiceStop':
                handleVoiceStop();
                break;
            // ── Plan Mode messages ──
            case 'updatePlan':
                currentPlan = message.plan;
                if (currentPlan && currentPlan._proposedSplit) {
                    proposedSplit = currentPlan._proposedSplit;
                    delete currentPlan._proposedSplit;
                }
                renderPlanBoard();
                break;
            case 'planTaskStatusChanged':
                if (currentPlan) {
                    updatePlanTaskStatus(message.taskId, message.status, message.note);
                }
                break;
            case 'planAutoAdvancing':
                // Flash notification that we're auto-advancing
                showPlanAutoAdvanceNotice(message.taskId, message.nextTaskId, message.nextTaskTitle);
                break;
            case 'planExecutionStarted':
                planExecuting = true;
                updatePlanExecutionUI();
                break;
            case 'planExecutionPaused':
                planExecuting = false;
                updatePlanExecutionUI();
                break;
            case 'updateWorkerQueue':
                handleWorkerQueueUpdate(message.tasks);
                break;
            case 'availableModels':
                availableModels = message.models || [];
                initWorkerModelDefault('command');
                initWorkerModelDefault('subagent');
                break;
            case 'availableTools':
                availableTools = filterMinimalWorkerTools(message.tools);
                ['command', 'subagent'].forEach(function(role) {
                    var lbl = document.getElementById(role + '-tools-label');
                    var total = availableTools.length;
                    var sel = workerSelectedTools[role];
                    var cnt = sel ? sel.size : total;
                    if (lbl) lbl.textContent = cnt + '/' + total + ' tools selected';
                    if (workerToolsExpanded[role]) renderToolsPicker(role);
                });
                break;
        }
    }

    function showPendingToolCall(id, prompt, isApproval, choices) {
        console.log('[TaskSync Webview] showPendingToolCall called with id:', id);
        pendingToolCall = { id: id, prompt: prompt };
        isProcessingResponse = false; // AI is now asking, not processing
        isApprovalQuestion = isApproval === true;
        currentChoices = choices || [];

        if (welcomeSection) {
            welcomeSection.classList.add('hidden');
        }

        // Add pending class to disable session switching UI
        document.body.classList.add('has-pending-toolcall');

        // Show AI question as plain text (hide "Working...." since AI asked a question)
        if (pendingMessage) {
            console.log('[TaskSync Webview] Setting pendingMessage innerHTML...');
            pendingMessage.classList.remove('hidden');
            pendingMessage.innerHTML = '<div class="pending-ai-question">' + formatMarkdown(prompt) + '</div>';
            console.log('[TaskSync Webview] pendingMessage.innerHTML set, length:', pendingMessage.innerHTML.length);
        } else {
            console.error('[TaskSync Webview] pendingMessage element is null!');
        }

        // Re-render current session (without the pending item - it's shown separately)
        renderCurrentSession();
        // Render any mermaid diagrams in pending message
        renderMermaidDiagrams();
        // Auto-scroll to show the new pending message
        scrollToBottom();

        // Show choice buttons if we have choices, otherwise show approval modal for yes/no questions
        // Only show if interactive approval is enabled
        if (interactiveApprovalEnabled) {
            if (currentChoices.length > 0) {
                showChoicesBar();
            } else if (isApprovalQuestion) {
                showApprovalModal();
            } else {
                hideApprovalModal();
                hideChoicesBar();
            }
        } else {
            // Interactive approval disabled - just focus input for manual typing
            hideApprovalModal();
            hideChoicesBar();
            if (chatInput) {
                chatInput.focus();
            }
        }
    }

    function addToolCallToCurrentSession(entry) {
        pendingToolCall = null;

        // Remove pending class to re-enable session switching UI
        document.body.classList.remove('has-pending-toolcall');

        // Hide approval modal and choices bar when tool call completes
        hideApprovalModal();
        hideChoicesBar();

        // Update or add entry to current session
        var idx = currentSessionCalls.findIndex(function (tc) { return tc.id === entry.id; });
        if (idx >= 0) {
            currentSessionCalls[idx] = entry;
        } else {
            currentSessionCalls.unshift(entry);
        }
        renderCurrentSession();

        // Show working indicator after user responds (AI is now processing the response)
        isProcessingResponse = true;
        if (pendingMessage) {
            pendingMessage.classList.remove('hidden');
            pendingMessage.innerHTML = '<div class="working-indicator">Processing your response</div>';
        }

        // Auto-scroll to show the working indicator
        scrollToBottom();
    }

    function renderCurrentSession() {
        if (!toolHistoryArea) return;

        // Only show COMPLETED calls from current session (pending is shown separately as plain text)
        var completedCalls = currentSessionCalls.filter(function (tc) { return tc.status === 'completed'; });

        if (completedCalls.length === 0) {
            toolHistoryArea.innerHTML = '';
            return;
        }

        // Reverse to show oldest first (new items stack at bottom)
        var sortedCalls = completedCalls.slice().reverse();

        var cardsHtml = sortedCalls.map(function (tc, index) {
            // Get first sentence for title - render inline markdown (bold/italic/code)
            var firstSentence = tc.prompt.split(/[.!?\n]/)[0];
            var truncatedTitle = firstSentence.length > 120 ? firstSentence.substring(0, 120) + '...' : firstSentence;
            var queueBadge = tc.isFromQueue ? '<span class="tool-call-badge queue">Queue</span>' : '';
            var tsHtml = formatCallTimestamp(tc.askedAt, tc.timestamp);

            // Build card HTML - NO X button for current session cards
            var isLatest = index === sortedCalls.length - 1;
            var cardHtml = '<div class="tool-call-card' + (isLatest ? ' expanded' : '') + '" data-id="' + escapeHtml(tc.id) + '">' +
                '<div class="tool-call-header">' +
                '<div class="tool-call-chevron"><span class="codicon codicon-chevron-down"></span></div>' +
                '<div class="tool-call-icon"><span class="codicon codicon-copilot"></span></div>' +
                '<div class="tool-call-header-wrapper">' +
                '<span class="tool-call-title">' + inlineMarkdown(truncatedTitle) + queueBadge + '</span>' +
                (tsHtml ? '<span class="tool-call-timestamp">' + tsHtml + '</span>' : '') +
                '</div>' +
                '</div>' +
                '<div class="tool-call-body">' +
                '<div class="tool-call-ai-response">' + formatMarkdown(tc.prompt) + '</div>' +
                '<div class="tool-call-user-section">' +
                '<div class="tool-call-user-response">' + escapeHtml(tc.response).replace(/\n/g, '<br>') + '</div>' +
                (tc.attachments ? renderAttachmentsHtml(tc.attachments) : '') +
                '</div>' +
                '</div></div>';
            return cardHtml;
        }).join('');

        toolHistoryArea.innerHTML = cardsHtml;

        // Bind events - only expand/collapse, no remove
        toolHistoryArea.querySelectorAll('.tool-call-header').forEach(function (header) {
            header.addEventListener('click', function (e) {
                var card = header.closest('.tool-call-card');
                if (card) card.classList.toggle('expanded');
            });
        });

        // Render any mermaid diagrams
        renderMermaidDiagrams();
    }

    function renderHistoryModal() {
        if (!historyModalList) return;

        if (persistedHistory.length === 0) {
            historyModalList.innerHTML = '<div class="history-modal-empty">No history yet</div>';
            if (historyModalClearAll) historyModalClearAll.classList.add('hidden');
            return;
        }

        if (historyModalClearAll) historyModalClearAll.classList.remove('hidden');

        // Helper to render tool call card
        function renderToolCallCard(tc) {
            var firstSentence = tc.prompt.split(/[.!?\n]/)[0];
            var truncatedTitle = firstSentence.length > 80 ? firstSentence.substring(0, 80) + '...' : firstSentence;
            var queueBadge = tc.isFromQueue ? '<span class="tool-call-badge queue">Queue</span>' : '';
            var tsHtml = formatCallTimestamp(tc.askedAt, tc.timestamp);

            return '<div class="tool-call-card history-card" data-id="' + escapeHtml(tc.id) + '">' +
                '<div class="tool-call-header">' +
                '<div class="tool-call-chevron"><span class="codicon codicon-chevron-down"></span></div>' +
                '<div class="tool-call-icon"><span class="codicon codicon-copilot"></span></div>' +
                '<div class="tool-call-header-wrapper">' +
                '<span class="tool-call-title">' + inlineMarkdown(truncatedTitle) + queueBadge + '</span>' +
                (tsHtml ? '<span class="tool-call-timestamp">' + tsHtml + '</span>' : '') +
                '</div>' +
                '<button class="tool-call-remove" data-id="' + escapeHtml(tc.id) + '" title="Remove"><span class="codicon codicon-close"></span></button>' +
                '</div>' +
                '<div class="tool-call-body">' +
                '<div class="tool-call-ai-response">' + formatMarkdown(tc.prompt) + '</div>' +
                '<div class="tool-call-user-section">' +
                '<div class="tool-call-user-response">' + escapeHtml(tc.response).replace(/\n/g, '<br>') + '</div>' +
                (tc.attachments ? renderAttachmentsHtml(tc.attachments) : '') +
                '</div>' +
                '</div></div>';
        }

        // Render all history items directly without grouping
        var cardsHtml = '<div class="history-items-list">';
        cardsHtml += persistedHistory.map(renderToolCallCard).join('');
        cardsHtml += '</div>';

        historyModalList.innerHTML = cardsHtml;

        // Bind expand/collapse events
        historyModalList.querySelectorAll('.tool-call-header').forEach(function (header) {
            header.addEventListener('click', function (e) {
                if (e.target.closest('.tool-call-remove')) return;
                var card = header.closest('.tool-call-card');
                if (card) card.classList.toggle('expanded');
            });
        });

        // Bind remove buttons
        historyModalList.querySelectorAll('.tool-call-remove').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var id = btn.getAttribute('data-id');
                if (id) {
                    vscode.postMessage({ type: 'removeHistoryItem', callId: id });
                    persistedHistory = persistedHistory.filter(function (tc) { return tc.id !== id; });
                    renderHistoryModal();
                }
            });
        });
    }

    // Constants for security and performance limits
    var MARKDOWN_MAX_LENGTH = 100000; // Max markdown input length to prevent ReDoS
    var MAX_TABLE_ROWS = 100; // Max table rows to process

    /**
     * Process a buffer of table lines into HTML table markup (ReDoS-safe implementation)
     * @param {string[]} lines - Array of table row strings
     * @param {number} maxRows - Maximum number of rows to process
     * @returns {string} HTML table markup or original lines joined
     */
    function processTableBuffer(lines, maxRows) {
        if (lines.length < 2) return lines.join('\n');
        if (lines.length > maxRows) return lines.join('\n'); // Skip very large tables

        // Check if second line is separator (contains only |, -, :, spaces)
        var separatorRegex = /^\|[\s\-:|]+\|$/;
        if (!separatorRegex.test(lines[1].trim())) return lines.join('\n');

        // Parse header
        var headerCells = lines[0].split('|').filter(function (c) { return c.trim() !== ''; });
        if (headerCells.length === 0) return lines.join('\n'); // Invalid table

        var headerHtml = '<tr>' + headerCells.map(function (c) {
            return '<th>' + c.trim() + '</th>';
        }).join('') + '</tr>';

        // Parse data rows (skip separator at index 1)
        var bodyHtml = '';
        for (var i = 2; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            var cells = lines[i].split('|').filter(function (c) { return c.trim() !== ''; });
            bodyHtml += '<tr>' + cells.map(function (c) {
                return '<td>' + c.trim() + '</td>';
            }).join('') + '</tr>';
        }

        return '<table class="markdown-table"><thead>' + headerHtml + '</thead><tbody>' + bodyHtml + '</tbody></table>';
    }

    function formatMarkdown(text) {
        if (!text) return '';

        // ReDoS prevention: truncate very long inputs before regex processing
        // This prevents exponential backtracking on crafted inputs (OWASP ReDoS mitigation)
        if (text.length > MARKDOWN_MAX_LENGTH) {
            text = text.substring(0, MARKDOWN_MAX_LENGTH) + '\n... (content truncated for display)';
        }

        // Normalize line endings (Windows \r\n to \n)
        var processedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // Store code blocks BEFORE escaping HTML to preserve backticks
        var codeBlocks = [];
        var mermaidBlocks = [];

        // Extract mermaid blocks first (before HTML escaping)
        // Match ```mermaid followed by newline or just content
        processedText = processedText.replace(/```mermaid\s*\n([\s\S]*?)```/g, function (match, code) {
            var index = mermaidBlocks.length;
            mermaidBlocks.push(code.trim());
            return '%%MERMAID' + index + '%%';
        });

        // Extract other code blocks (before HTML escaping)
        // Match ```lang or just ``` followed by optional newline
        processedText = processedText.replace(/```(\w*)\s*\n?([\s\S]*?)```/g, function (match, lang, code) {
            var index = codeBlocks.length;
            codeBlocks.push({ lang: lang || '', code: code.trim() });
            return '%%CODEBLOCK' + index + '%%';
        });

        // Now escape HTML on the remaining text
        var html = escapeHtml(processedText);

        // Headers (## Header) - must be at start of line
        html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
        html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
        html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

        // Horizontal rules (--- or ***)
        html = html.replace(/^---+$/gm, '<hr>');
        html = html.replace(/^\*\*\*+$/gm, '<hr>');

        // Blockquotes (> text) - simple single-line support
        html = html.replace(/^&gt;\s*(.*)$/gm, '<blockquote>$1</blockquote>');
        // Merge consecutive blockquotes
        html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

        // Unordered lists (- item or * item)
        html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
        // Wrap consecutive <li> in <ul>
        html = html.replace(/(<li>.*<\/li>\n?)+/g, function (match) {
            return '<ul>' + match.replace(/\n/g, '') + '</ul>';
        });

        // Ordered lists (1. item)
        html = html.replace(/^\d+\.\s+(.+)$/gm, '<oli>$1</oli>');
        // Wrap consecutive <oli> in <ol> then convert to li
        html = html.replace(/(<oli>.*<\/oli>\n?)+/g, function (match) {
            return '<ol>' + match.replace(/<oli>/g, '<li>').replace(/<\/oli>/g, '</li>').replace(/\n/g, '') + '</ol>';
        });

        // Markdown tables - SAFE approach to prevent ReDoS
        // Instead of using nested quantifiers with regex (which can cause exponential backtracking),
        // we use a line-by-line processing approach for safety
        var tableLines = html.split('\n');
        var processedLines = [];
        var tableBuffer = [];
        var inTable = false;

        for (var lineIdx = 0; lineIdx < tableLines.length; lineIdx++) {
            var line = tableLines[lineIdx];
            // Check if line looks like a table row (starts and ends with |)
            var isTableRow = /^\|.+\|$/.test(line.trim());

            if (isTableRow) {
                tableBuffer.push(line);
                inTable = true;
            } else {
                if (inTable && tableBuffer.length >= 2) {
                    // Process accumulated table buffer
                    var tableHtml = processTableBuffer(tableBuffer, MAX_TABLE_ROWS);
                    processedLines.push(tableHtml);
                }
                tableBuffer = [];
                inTable = false;
                processedLines.push(line);
            }
        }
        // Handle table at end of content
        if (inTable && tableBuffer.length >= 2) {
            processedLines.push(processTableBuffer(tableBuffer, MAX_TABLE_ROWS));
        }
        html = processedLines.join('\n');

        // Inline code (`code`)
        html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

        // Bold (**text** or __text__)
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

        // Italic (*text* or _text_)
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

        // Line breaks - but collapse multiple consecutive breaks
        // Don't add <br> after block elements
        html = html.replace(/\n{3,}/g, '\n\n');
        html = html.replace(/(<\/h[1-6]>|<\/ul>|<\/ol>|<\/blockquote>|<hr>)\n/g, '$1');
        html = html.replace(/\n/g, '<br>');

        // Restore code blocks
        codeBlocks.forEach(function (block, index) {
            var langAttr = block.lang ? ' data-lang="' + block.lang + '"' : '';
            var escapedCode = escapeHtml(block.code);
            var replacement = '<pre class="code-block"' + langAttr + '><code>' + escapedCode + '</code></pre>';
            html = html.replace('%%CODEBLOCK' + index + '%%', replacement);
        });

        // Restore mermaid blocks as diagrams
        mermaidBlocks.forEach(function (code, index) {
            var mermaidId = 'mermaid-' + Date.now() + '-' + index + '-' + Math.random().toString(36).substr(2, 9);
            var replacement = '<div class="mermaid-container" data-mermaid-id="' + mermaidId + '"><div class="mermaid" id="' + mermaidId + '">' + escapeHtml(code) + '</div></div>';
            html = html.replace('%%MERMAID' + index + '%%', replacement);
        });

        // Clean up excessive <br> around block elements
        html = html.replace(/(<br>)+(<pre|<div class="mermaid|<h[1-6]|<ul|<ol|<blockquote|<hr)/g, '$2');
        html = html.replace(/(<\/pre>|<\/div>|<\/h[1-6]>|<\/ul>|<\/ol>|<\/blockquote>|<hr>)(<br>)+/g, '$1');

        return html;
    }

    // Mermaid rendering - lazy load and render
    var mermaidLoaded = false;
    var mermaidLoading = false;

    function loadMermaid(callback) {
        if (mermaidLoaded) {
            callback();
            return;
        }
        if (mermaidLoading) {
            // Wait for existing load
            var checkInterval = setInterval(function () {
                if (mermaidLoaded) {
                    clearInterval(checkInterval);
                    callback();
                }
            }, 50);
            return;
        }
        mermaidLoading = true;

        var script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
        script.onload = function () {
            window.mermaid.initialize({
                startOnLoad: false,
                theme: document.body.classList.contains('vscode-light') ? 'default' : 'dark',
                securityLevel: 'loose',
                fontFamily: 'var(--vscode-font-family)'
            });
            mermaidLoaded = true;
            mermaidLoading = false;
            callback();
        };
        script.onerror = function () {
            mermaidLoading = false;
            console.error('Failed to load mermaid.js');
        };
        document.head.appendChild(script);
    }

    function renderMermaidDiagrams() {
        var containers = document.querySelectorAll('.mermaid-container:not(.rendered)');
        if (containers.length === 0) return;

        loadMermaid(function () {
            containers.forEach(function (container) {
                var mermaidDiv = container.querySelector('.mermaid');
                if (!mermaidDiv) return;

                var code = mermaidDiv.textContent;
                var id = mermaidDiv.id;

                try {
                    window.mermaid.render(id + '-svg', code).then(function (result) {
                        mermaidDiv.innerHTML = result.svg;
                        container.classList.add('rendered');
                    }).catch(function (err) {
                        // Show code block as fallback on error
                        mermaidDiv.innerHTML = '<pre class="code-block" data-lang="mermaid"><code>' + escapeHtml(code) + '</code></pre>';
                        container.classList.add('rendered', 'error');
                    });
                } catch (err) {
                    mermaidDiv.innerHTML = '<pre class="code-block" data-lang="mermaid"><code>' + escapeHtml(code) + '</code></pre>';
                    container.classList.add('rendered', 'error');
                }
            });
        });
    }

    /**
     * Update welcome section visibility based on current session state
     * Hide welcome when there are completed tool calls or a pending call
     */
    function updateWelcomeSectionVisibility() {
        if (!welcomeSection) return;
        var hasCompletedCalls = currentSessionCalls.some(function (tc) { return tc.status === 'completed'; });
        var hasPendingMessage = pendingMessage && !pendingMessage.classList.contains('hidden');
        var shouldHide = hasCompletedCalls || pendingToolCall !== null || hasPendingMessage;
        welcomeSection.classList.toggle('hidden', shouldHide);
    }

    /**
     * Auto-scroll chat container to bottom
     */
    function scrollToBottom() {
        if (!chatContainer) return;
        // Use requestAnimationFrame to ensure DOM is updated before scrolling
        requestAnimationFrame(function () {
            chatContainer.scrollTop = chatContainer.scrollHeight;
        });
    }

    function addToQueue(prompt) {
        if (!prompt || !prompt.trim()) return;
        var id = 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
        // Store attachments with the queue item
        var attachmentsToStore = currentAttachments.length > 0 ? currentAttachments.slice() : undefined;
        promptQueue.push({ id: id, prompt: prompt.trim(), attachments: attachmentsToStore });
        renderQueue();
        // Expand queue section when adding items so user can see what was added
        if (queueSection) queueSection.classList.remove('collapsed');
        // Send to backend with attachments
        vscode.postMessage({ type: 'addQueuePrompt', prompt: prompt.trim(), id: id, attachments: attachmentsToStore || [] });
        // Clear attachments after adding to queue (they're now stored with the queue item)
        currentAttachments = [];
        updateChipsDisplay();
    }

    function removeFromQueue(id) {
        promptQueue = promptQueue.filter(function (item) { return item.id !== id; });
        renderQueue();
        vscode.postMessage({ type: 'removeQueuePrompt', promptId: id });
    }

    function renderQueue() {
        if (!queueList) return;
        if (queueCount) queueCount.textContent = promptQueue.length;

        // Update visibility based on queue state
        updateQueueVisibility();

        if (promptQueue.length === 0) {
            queueList.innerHTML = '<div class="queue-empty">No prompts in queue</div>';
            return;
        }

        queueList.innerHTML = promptQueue.map(function (item, index) {
            var bulletClass = index === 0 ? 'active' : 'pending';
            var truncatedPrompt = item.prompt.length > 80 ? item.prompt.substring(0, 80) + '...' : item.prompt;
            // Show attachment indicator if this queue item has attachments
            var attachmentBadge = (item.attachments && item.attachments.length > 0)
                ? '<span class="queue-item-attachment-badge" title="' + item.attachments.length + ' attachment(s)" aria-label="' + item.attachments.length + ' attachments"><span class="codicon codicon-file-media" aria-hidden="true"></span></span>'
                : '';
            return '<div class="queue-item" data-id="' + escapeHtml(item.id) + '" data-index="' + index + '" tabindex="0" draggable="true" role="listitem" aria-label="Queue item ' + (index + 1) + ': ' + escapeHtml(truncatedPrompt) + '">' +
                '<span class="bullet ' + bulletClass + '" aria-hidden="true"></span>' +
                '<span class="text" title="' + escapeHtml(item.prompt) + '">' + (index + 1) + '. ' + escapeHtml(truncatedPrompt) + '</span>' +
                attachmentBadge +
                '<div class="queue-item-actions">' +
                '<button class="edit-btn" data-id="' + escapeHtml(item.id) + '" title="Edit" aria-label="Edit queue item ' + (index + 1) + '"><span class="codicon codicon-edit" aria-hidden="true"></span></button>' +
                '<button class="remove-btn" data-id="' + escapeHtml(item.id) + '" title="Remove" aria-label="Remove queue item ' + (index + 1) + '"><span class="codicon codicon-close" aria-hidden="true"></span></button>' +
                '</div></div>';
        }).join('');

        queueList.querySelectorAll('.remove-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var id = btn.getAttribute('data-id');
                if (id) removeFromQueue(id);
            });
        });

        queueList.querySelectorAll('.edit-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var id = btn.getAttribute('data-id');
                if (id) startEditPrompt(id);
            });
        });

        bindDragAndDrop();
        bindKeyboardNavigation();
    }

    function startEditPrompt(id) {
        // Cancel any existing edit first
        if (editingPromptId && editingPromptId !== id) {
            cancelEditMode();
        }

        var item = promptQueue.find(function (p) { return p.id === id; });
        if (!item) return;

        // Save current state
        editingPromptId = id;
        editingOriginalPrompt = item.prompt;
        savedInputValue = chatInput ? chatInput.value : '';

        // Mark queue item as being edited
        var queueItem = queueList.querySelector('.queue-item[data-id="' + id + '"]');
        if (queueItem) {
            queueItem.classList.add('editing');
        }

        // Switch to edit mode UI
        enterEditMode(item.prompt);
    }

    function enterEditMode(promptText) {
        // Hide normal actions, show edit actions
        if (actionsLeft) actionsLeft.classList.add('hidden');
        if (sendBtn) sendBtn.classList.add('hidden');
        if (editActionsContainer) editActionsContainer.classList.remove('hidden');

        // Mark input container as in edit mode
        if (inputContainer) {
            inputContainer.classList.add('edit-mode');
            inputContainer.setAttribute('aria-label', 'Editing queue prompt');
        }

        // Set input value to the prompt being edited
        if (chatInput) {
            chatInput.value = promptText;
            chatInput.setAttribute('aria-label', 'Edit prompt text. Press Enter to confirm, Escape to cancel.');
            chatInput.focus();
            // Move cursor to end
            chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
            autoResizeTextarea();
        }
    }

    function exitEditMode() {
        // Show normal actions, hide edit actions
        if (actionsLeft) actionsLeft.classList.remove('hidden');
        if (sendBtn) sendBtn.classList.remove('hidden');
        if (editActionsContainer) editActionsContainer.classList.add('hidden');

        // Remove edit mode class from input container
        if (inputContainer) {
            inputContainer.classList.remove('edit-mode');
            inputContainer.removeAttribute('aria-label');
        }

        // Remove editing class from queue item
        if (queueList) {
            var editingItem = queueList.querySelector('.queue-item.editing');
            if (editingItem) editingItem.classList.remove('editing');
        }

        // Restore original input value and accessibility
        if (chatInput) {
            chatInput.value = savedInputValue;
            chatInput.setAttribute('aria-label', 'Message input');
            autoResizeTextarea();
        }

        // Reset edit state
        editingPromptId = null;
        editingOriginalPrompt = null;
        savedInputValue = '';
    }

    function confirmEditMode() {
        if (!editingPromptId) return;

        var newValue = chatInput ? chatInput.value.trim() : '';

        if (!newValue) {
            // If empty, remove the prompt
            removeFromQueue(editingPromptId);
        } else if (newValue !== editingOriginalPrompt) {
            // Update the prompt
            var item = promptQueue.find(function (p) { return p.id === editingPromptId; });
            if (item) {
                item.prompt = newValue;
                vscode.postMessage({ type: 'editQueuePrompt', promptId: editingPromptId, newPrompt: newValue });
            }
        }

        // Clear saved input - we don't want to restore old value after editing
        savedInputValue = '';

        exitEditMode();
        renderQueue();
    }

    function cancelEditMode() {
        exitEditMode();
        renderQueue();
    }

    /**
     * Handle "accept" button click in approval modal
     * Sends "yes" as the response
     */
    function handleApprovalContinue() {
        if (!pendingToolCall) return;

        // Hide approval modal
        hideApprovalModal();

        // Send affirmative response
        vscode.postMessage({ type: 'submit', value: 'yes', attachments: [] });
        if (chatInput) {
            chatInput.value = '';
            chatInput.style.height = 'auto';
            updateInputHighlighter();
        }
        currentAttachments = [];
        updateChipsDisplay();
        updateSendButtonState();
        saveWebviewState();
    }

    /**
     * Handle "No" button click in approval modal
     * Dismisses modal and focuses input for custom response
     */
    function handleApprovalNo() {
        // Hide approval modal but keep pending state
        hideApprovalModal();

        // Focus input for custom response
        if (chatInput) {
            chatInput.focus();
            // Optionally pre-fill with "No, " to help user
            if (!chatInput.value.trim()) {
                chatInput.value = 'No, ';
                chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
            }
            autoResizeTextarea();
            updateInputHighlighter();
            updateSendButtonState();
            saveWebviewState();
        }
    }

    /**
     * Show approval modal
     */
    function showApprovalModal() {
        if (!approvalModal) return;
        approvalModal.classList.remove('hidden');
        // Focus chat input instead of Yes button to prevent accidental Enter approvals
        // User can still click Yes/No or use keyboard navigation
        if (chatInput) {
            chatInput.focus();
        }
    }

    /**
     * Hide approval modal
     */
    function hideApprovalModal() {
        if (!approvalModal) return;
        approvalModal.classList.add('hidden');
        isApprovalQuestion = false;
    }

    /**
     * Show choices bar with dynamic buttons based on parsed choices
     */
    function showChoicesBar() {
        // Hide approval modal first
        hideApprovalModal();

        // Create or get choices bar
        var choicesBar = document.getElementById('choices-bar');
        if (!choicesBar) {
            choicesBar = document.createElement('div');
            choicesBar.className = 'choices-bar';
            choicesBar.id = 'choices-bar';
            choicesBar.setAttribute('role', 'toolbar');
            choicesBar.setAttribute('aria-label', 'Quick choice options');

            // Insert at top of input-wrapper
            var inputWrapper = document.getElementById('input-wrapper');
            if (inputWrapper) {
                inputWrapper.insertBefore(choicesBar, inputWrapper.firstChild);
            }
        }

        // Build choice buttons
        var buttonsHtml = currentChoices.map(function (choice, index) {
            var shortLabel = choice.shortLabel || choice.value;
            var title = choice.label || choice.value;
            return '<button class="choice-btn" data-value="' + escapeHtml(choice.value) + '" ' +
                'data-index="' + index + '" title="' + escapeHtml(title) + '">' +
                escapeHtml(shortLabel) + '</button>';
        }).join('');

        choicesBar.innerHTML = '<span class="choices-label">Choose:</span>' +
            '<div class="choices-buttons">' + buttonsHtml + '</div>';

        // Bind click events to choice buttons
        choicesBar.querySelectorAll('.choice-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var value = btn.getAttribute('data-value');
                handleChoiceClick(value);
            });
        });

        choicesBar.classList.remove('hidden');

        // Don't auto-focus buttons - let user click or use keyboard
        // Focus the chat input instead for immediate typing
        if (chatInput) {
            chatInput.focus();
        }
    }

    /**
     * Hide choices bar
     */
    function hideChoicesBar() {
        var choicesBar = document.getElementById('choices-bar');
        if (choicesBar) {
            choicesBar.classList.add('hidden');
        }
        currentChoices = [];
    }

    /**
     * Handle choice button click
     */
    function handleChoiceClick(value) {
        if (!pendingToolCall) return;

        // Hide choices bar
        hideChoicesBar();

        // Send the choice value as response
        vscode.postMessage({ type: 'submit', value: value, attachments: [] });
        if (chatInput) {
            chatInput.value = '';
            chatInput.style.height = 'auto';
            updateInputHighlighter();
        }
        currentAttachments = [];
        updateChipsDisplay();
        updateSendButtonState();
        saveWebviewState();
    }

    // ===== SETTINGS MODAL FUNCTIONS =====

    function openSettingsModal() {
        switchTab('settings');
        vscode.postMessage({ type: 'openSettingsModal' });
    }

    function closeSettingsModal() {
        flushAutopilotTextUpdate();
        hideAddPromptForm();
        hideAddAutopilotPromptForm();
    }

    function toggleSoundSetting() {
        soundEnabled = !soundEnabled;
        updateSoundToggleUI();
        vscode.postMessage({ type: 'updateSoundSetting', enabled: soundEnabled });
    }

    function updateSoundToggleUI() {
        if (!soundToggle) return;
        soundToggle.classList.toggle('active', soundEnabled);
        soundToggle.setAttribute('aria-checked', soundEnabled ? 'true' : 'false');
    }

    function toggleInteractiveApprovalSetting() {
        interactiveApprovalEnabled = !interactiveApprovalEnabled;
        updateInteractiveApprovalToggleUI();
        vscode.postMessage({ type: 'updateInteractiveApprovalSetting', enabled: interactiveApprovalEnabled });
    }

    function updateInteractiveApprovalToggleUI() {
        if (!interactiveApprovalToggle) return;
        interactiveApprovalToggle.classList.toggle('active', interactiveApprovalEnabled);
        interactiveApprovalToggle.setAttribute('aria-checked', interactiveApprovalEnabled ? 'true' : 'false');
    }

    function toggleWebexSetting() {
        webexEnabled = !webexEnabled;
        updateWebexToggleUI();
        vscode.postMessage({ type: 'updateWebexSetting', enabled: webexEnabled });
    }

    function updateWebexToggleUI() {
        if (!webexToggle) return;
        webexToggle.classList.toggle('active', webexEnabled);
        webexToggle.setAttribute('aria-checked', webexEnabled ? 'true' : 'false');
    }

    function updateWebexStatusUI(status) {
        var el = document.getElementById('webex-status');
        if (!el) return;
        if (!status) { el.textContent = ''; return; }
        var icon = status.status === 'connected' ? '✅' : status.status === 'disabled' ? '⏸' : '⚠️';
        el.textContent = icon + ' ' + status.message;
        if (status.hint) {
            el.title = status.hint;
        }
        el.className = 'settings-status settings-status-' + status.status;
    }

    function toggleTelegramSetting() {
        telegramEnabled = !telegramEnabled;
        updateTelegramToggleUI();
        vscode.postMessage({ type: 'updateTelegramSetting', enabled: telegramEnabled });
    }

    function updateTelegramToggleUI() {
        if (!telegramToggle) return;
        telegramToggle.classList.toggle('active', telegramEnabled);
        telegramToggle.setAttribute('aria-checked', telegramEnabled ? 'true' : 'false');
    }

    function updateTelegramStatusUI(status) {
        var el = document.getElementById('telegram-status');
        if (!el) return;
        if (!status) { el.textContent = ''; return; }
        var icon = status.status === 'connected' ? '✅' : status.status === 'disabled' ? '⏸' : '⚠️';
        el.textContent = icon + ' ' + status.message;
        if (status.hint) {
            el.title = status.hint;
        }
        el.className = 'settings-status settings-status-' + status.status;
    }

    function toggleAutopilotSetting() {
        autopilotEnabled = !autopilotEnabled;
        updateAutopilotToggleUI();
        vscode.postMessage({ type: 'updateAutopilotSetting', enabled: autopilotEnabled });
    }

    function updateAutopilotToggleUI() {
        if (autopilotToggle) {
            autopilotToggle.classList.toggle('active', autopilotEnabled);
            autopilotToggle.setAttribute('aria-checked', autopilotEnabled ? 'true' : 'false');
        }
    }

    function toggleSendWithCtrlEnterSetting() {
        sendWithCtrlEnter = !sendWithCtrlEnter;
        updateSendWithCtrlEnterToggleUI();
        vscode.postMessage({ type: 'updateSendWithCtrlEnterSetting', enabled: sendWithCtrlEnter });
    }

    function updateSendWithCtrlEnterToggleUI() {
        if (!sendShortcutToggle) return;
        sendShortcutToggle.classList.toggle('active', sendWithCtrlEnter);
        sendShortcutToggle.setAttribute('aria-checked', sendWithCtrlEnter ? 'true' : 'false');
    }

    function toggleDebugLoggingSetting() {
        debugLoggingEnabled = !debugLoggingEnabled;
        updateDebugLoggingToggleUI();
        vscode.postMessage({ type: 'updateDebugLoggingSetting', enabled: debugLoggingEnabled });
    }

    function updateDebugLoggingToggleUI() {
        if (!debugLoggingToggle) return;
        debugLoggingToggle.classList.toggle('active', debugLoggingEnabled);
        debugLoggingToggle.setAttribute('aria-checked', debugLoggingEnabled ? 'true' : 'false');
    }

    function toggleAutoCompactionSetting() {
        autoCompactionDisabled = !autoCompactionDisabled;
        updateAutoCompactionToggleUI();
        vscode.postMessage({ type: 'updateAutoCompactionDisabled', disabled: autoCompactionDisabled });
    }

    function updateAutoCompactionToggleUI() {
        if (!autoCompactionToggle) return;
        autoCompactionToggle.classList.toggle('active', autoCompactionDisabled);
        autoCompactionToggle.setAttribute('aria-checked', autoCompactionDisabled ? 'true' : 'false');
    }

    function toggleExtendedCacheTtl() {
        extendedCacheTtl = !extendedCacheTtl;
        updateCacheSettingsUI();
        vscode.postMessage({ type: 'updateExtendedCacheTtl', enabled: extendedCacheTtl });
    }

    function toggleExtendedCacheTtlMessages() {
        extendedCacheTtlMessages = !extendedCacheTtlMessages;
        updateCacheSettingsUI();
        vscode.postMessage({ type: 'updateExtendedCacheTtlMessages', enabled: extendedCacheTtlMessages });
    }

    function toggleCacheKeepWarm() {
        cacheKeepWarmEnabled = !cacheKeepWarmEnabled;
        updateCacheSettingsUI();
        vscode.postMessage({ type: 'updateCacheKeepWarm', enabled: cacheKeepWarmEnabled });
    }

    function updateCacheSettingsUI() {
        if (extendedCacheTtlToggle) {
            extendedCacheTtlToggle.classList.toggle('active', extendedCacheTtl);
            extendedCacheTtlToggle.setAttribute('aria-checked', extendedCacheTtl ? 'true' : 'false');
        }
        if (extendedCacheTtlMessagesToggle) {
            extendedCacheTtlMessagesToggle.classList.toggle('active', extendedCacheTtlMessages);
            extendedCacheTtlMessagesToggle.setAttribute('aria-checked', extendedCacheTtlMessages ? 'true' : 'false');
        }
        if (cacheKeepWarmToggle) {
            cacheKeepWarmToggle.classList.toggle('active', cacheKeepWarmEnabled);
            cacheKeepWarmToggle.setAttribute('aria-checked', cacheKeepWarmEnabled ? 'true' : 'false');
        }
        if (cacheKeepWarmProbesInput && document.activeElement !== cacheKeepWarmProbesInput) {
            cacheKeepWarmProbesInput.value = String(cacheKeepWarmProbes);
        }
    }

    function toggleRtkCompressionSetting() {
        if (!rtkInstalled) { return; }
        rtkCompressionEnabled = !rtkCompressionEnabled;
        updateRtkCompressionToggleUI();
        vscode.postMessage({ type: 'updateRtkCompressionSetting', enabled: rtkCompressionEnabled });
    }

    function updateRtkCompressionToggleUI() {
        if (!rtkCompressionToggle) return;
        rtkCompressionToggle.classList.toggle('active', rtkCompressionEnabled && rtkInstalled);
        rtkCompressionToggle.setAttribute('aria-checked', (rtkCompressionEnabled && rtkInstalled) ? 'true' : 'false');
        rtkCompressionToggle.classList.toggle('toggle-disabled', !rtkInstalled);
        var section = rtkCompressionToggle.closest('.settings-section');
        if (section) {
            var titleEl = section.querySelector('.settings-section-title');
            if (titleEl) {
                titleEl.innerHTML = '<span class="codicon codicon-server-process"></span> RTK Command Compression' +
                    (rtkInstalled ? '' : ' <span class="obs-na" style="font-size:10px">(rtk not installed)</span>');
            }
        }
    }

    function renderCacheAge() {
        var el = document.getElementById('obs-cache-age');
        if (!el) { return; }
        var ts = Number(observabilityMetrics.lastRequestTs) || 0;
        if (!ts) { el.textContent = 'Prompt cache age: \u2013'; el.className = 'obs-cache-age'; return; }
        var secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        var capped = Math.min(secs, 300); // never display beyond the 5:00 cache TTL
        var mm = Math.floor(capped / 60), ss = capped % 60;
        var clock = mm + ':' + (ss < 10 ? '0' : '') + ss;
        var state, cls;
        if (secs < 285) { state = 'warm \u2014 a new message should hit cache'; cls = 'obs-cache-age obs-cache-warm'; }
        else if (secs < 300) { state = 'cooling \u2014 send within 15s to keep the cache hit'; cls = 'obs-cache-age obs-cache-cooling'; }
        else { state = 'likely COLD \u2014 next message may be a cache MISS (pricier)'; cls = 'obs-cache-age obs-cache-cold'; }
        el.className = cls;
        el.innerHTML = 'Prompt cache age: <b>' + clock + '</b> / 5:00 \u00b7 ' + state;
        // Sound alert once per request-cycle when the cache is about to expire (~4:45), so the
        // user can hit Ping in time. Re-arms whenever a new request resets the clock (ts changes).
        if (soundEnabled && secs >= 285 && secs < 300) {
            if (window._obsCacheWarnedTs !== ts) {
                window._obsCacheWarnedTs = ts;
                try { playNotificationSound(); } catch (e) { /* ignore */ }
            }
        } else if (secs < 285 && window._obsCacheWarnedTs === ts) {
            // clock reset below the threshold for this cycle — allow a future re-arm
            window._obsCacheWarnedTs = null;
        }
    }

    function updateObservabilityUI() {
        var pendingCommands = workerTasks.filter(function (t) { return t.role === 'command' && t.status !== 'done'; }).length;
        var pendingAgents = workerTasks.filter(function (t) { return t.role === 'subagent' && t.status !== 'done'; }).length;
        if (observabilitySessionCalls) observabilitySessionCalls.textContent = String(currentSessionCalls.length);
        if (observabilityHistoryCount) observabilityHistoryCount.textContent = String(persistedHistory.length);
        if (observabilityPendingCommands) observabilityPendingCommands.textContent = String(pendingCommands);
        if (observabilityPendingAgents) observabilityPendingAgents.textContent = String(pendingAgents);
        if (observabilitySource) observabilitySource.textContent = observabilityMetrics.source || 'unavailable';

        var aiu = function (nano) { return formatObservabilityCompact((Number(nano) || 0) / 1000000000); };
        var num = formatObservabilityNumber;
        var tok = formatObservabilityCompact;

        var aiu = function (nano) { return formatObservabilityCompact((Number(nano) || 0) / 1000000000); };
        var num = formatObservabilityNumber;
        var tok = formatObservabilityCompact;
        var sec = function (ms) { return ((Number(ms) || 0) / 1000).toFixed(2); };

        var all = observabilityMetrics.overall || {};
        var tc = observabilityMetrics.toolCalls || {};

        var hitPct = function (s) {
            var inp = Number(s.inputTokens) || 0;
            if (inp <= 0) return '\u2013';
            return Math.round((Number(s.cachedTokens) || 0) / inp * 100) + '%';
        };
        var setCell = function (id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };
        var setHit = function (id, s) {
            var el = document.getElementById(id); if (!el) return;
            el.textContent = hitPct(s);
            var inp = Number(s.inputTokens) || 0;
            var pct = inp > 0 ? (Number(s.cachedTokens) || 0) / inp : 1;
            el.className = (inp > 0 && pct < 0.5) ? 'obs-cache-risk' : '';
        };
        // Render a per-tool table (times in seconds, 2dp) into the given tbody.
        var renderToolTable = function (tbodyId, scope) {
            var tb = document.getElementById(tbodyId);
            if (!tb) return;
            var bt = (scope && scope.byTool) || [];
            if (!bt.length) { tb.innerHTML = '<tr><td colspan="7" class="obs-na">No data yet</td></tr>'; return; }
            var rows = '';
            for (var j = 0; j < bt.length; j++) {
                var r = bt[j];
                var name = escapeHtml(String(r.tool || 'unknown'));
                if (r.cacheRisk) name += ' \u26a0';
                var maxCls = r.cacheRisk ? ' class="obs-cache-risk"' : '';
                rows += '<tr><td class="obs-scope">' + name + '</td>' +
                    '<td>' + num(r.calls) + '</td>' +
                    '<td>' + tok(r.outputTokens) + '</td>' +
                    '<td>' + sec(r.avgMs) + '</td>' +
                    '<td>' + sec(r.minMs) + '</td>' +
                    '<td' + maxCls + '>' + sec(r.maxMs) + '</td>' +
                    '<td>' + (r.errors ? num(r.errors) : '\u2013') + '</td></tr>';
            }
            tb.innerHTML = rows;
        };

        // ── View toggle: turn ⇄ month ──
        var turnView = document.getElementById('obs-turn-view');
        var monthView = document.getElementById('obs-month-view');
        var turnBtn = document.getElementById('obs-view-turn');
        var monthBtn = document.getElementById('obs-view-month');
        if (turnView) turnView.style.display = (obsView === 'turn') ? '' : 'none';
        if (monthView) monthView.style.display = (obsView === 'month') ? '' : 'none';
        if (turnBtn) turnBtn.classList.toggle('active', obsView === 'turn');
        if (monthBtn) monthBtn.classList.toggle('active', obsView === 'month');

        // Renders the per-request input breakdown shown inside an expandable detail row.
        function renderSplitDetail(split) {
            var sysT = Number(split.systemTokens) || 0;
            var toolsT = Number(split.toolsTokens) || 0;
            var convT = Number(split.conversationTokens) || 0;
            var userT = Number(split.userTokens) || 0;
            var msgs = Number(split.messageCount) || 0;
            var total = Number(split.totalInputTokens) || (sysT + toolsT + convT);
            // Plain-language label for what this request actually is.
            var kind = convT <= Math.max(50, sysT * 0.02)
                ? 'Start of conversation'
                : (userT > 0 ? 'Your message + history' : 'Follow-up after tool calls');
            var bar = '';
            if (total > 0) {
                var pctOf = function (v) { return v > 0 ? Math.max(2, Math.round(v / total * 100)) : 0; };
                var seg = function (cls, v, label) {
                    return v > 0 ? '<span class="obs-split-seg ' + cls + '" style="width:' + pctOf(v) + '%" title="' + label + ': ' + tok(v) + ' tok (' + Math.round(v / total * 100) + '%)"></span>' : '';
                };
                bar = '<div class="obs-split-bar">' +
                    seg('obs-split-sys', sysT, 'System prompt') +
                    seg('obs-split-tools', toolsT, 'Tool definitions') +
                    seg('obs-split-hist', convT, 'Conversation history') +
                    '</div>';
            }
            var line = function (cls, label, val, extra) {
                return '<div class="obs-split-line"><i class="' + cls + '"></i>' +
                    '<span class="obs-split-k">' + label + '</span>' +
                    '<span class="obs-split-v">' + val + '</span>' +
                    (extra ? '<span class="obs-split-x">' + extra + '</span>' : '') + '</div>';
            };
            return '<div class="obs-split">' +
                '<div class="obs-split-title">' + kind + ' \u2014 ' + tok(total) + ' tok total input</div>' +
                bar +
                '<div class="obs-split-lines">' +
                line('obs-split-sys', 'System prompt', tok(sysT) + ' tok', 'exact') +
                line('obs-split-tools', 'Tool definitions', tok(toolsT) + ' tok', (Number(split.toolsCount) || 0) + ' tools') +
                line('obs-split-hist', 'Conversation history', tok(convT) + ' tok', msgs + ' msgs \u00b7 derived') +
                line('obs-split-user', 'Latest message', tok(userT) + ' tok', 'exact') +
                '</div>' +
                '<div class="obs-split-note">Conversation = total \u2212 system \u2212 tools (cached history + this step\u2019s tool responses). Per-tool response sizes are the \u2191 output tokens on the tool rows above.</div>' +
                renderRequestContributors(split.contributors) +
                renderPromptComposition(split.composition) +
                '</div>';
        }

        // Full-request breakdown: everything that literally contributed to THIS request's input —
        // system prompt, tool defs, user memory, each attached file, context framing, tool results
        // and dialogue. Parsed from the request's own inputMessages, so it is exact (not a guess).
        function renderRequestContributors(c) {
            if (!c || !Array.isArray(c.items) || !c.items.length) { return ''; }
            var total = Number(c.totalInputTokens) || 0;
            var accounted = Number(c.accountedTokens) || 0;
            var cached = Number(c.cachedTokens) || 0;
            var hitPct = total > 0 ? Math.round(cached / total * 100) : 0;
            function row(it) {
                var t = Number(it.tokens) || 0;
                var pct = total > 0 ? Math.round(t / total * 100) : 0;
                var nameHtml = (it.kind === 'attachment' && it.path)
                    ? '<a href="#" class="obs-comp-file" data-path="' + escapeHtml(String(it.path)) + '" title="' + escapeHtml(String(it.path)) + '">' + escapeHtml(String(it.label)) + '</a>'
                    : '<span class="obs-comp-block">' + escapeHtml(String(it.label)) + '</span>';
                return '<div class="obs-comp-row obs-comp-' + escapeHtml(String(it.kind)) + '">' +
                    '<span class="obs-comp-tok">' + tok(t) + '</span>' +
                    '<span class="obs-comp-name">' + nameHtml + ' <span class="obs-comp-pct">' + pct + '%</span></span></div>';
            }
            var rows = '';
            for (var i = 0; i < c.items.length; i++) { rows += row(c.items[i]); }
            var missing = total - accounted;
            if (missing > 50) { rows += '<div class="obs-comp-row obs-comp-base"><span class="obs-comp-tok">' + tok(missing) + '</span><span class="obs-comp-name"><span class="obs-comp-block">Unattributed (Copilot base framing + provider-tokenizer variance)</span></span></div>'; }
            return '<div class="obs-comp">' +
                '<div class="obs-comp-header">Full request \u2014 ' + tok(total) + ' tok input \u00b7 ' + hitPct + '% cached</div>' +
                '<div class="obs-comp-list">' + rows + '</div></div>';
        }

        // Reverse-engineered "what files make up the system prompt" breakdown.
        // Flat + always visible (shown on the request row's initial expansion, no extra clicks),
        // left-aligned so long file paths read from the left with no horizontal scroll.
        function renderPromptComposition(comp) {
            if (!comp || !Array.isArray(comp.segments) || !comp.segments.length) { return ''; }
            var totalC = Number(comp.totalTokens) || 0;
            var baseC = Number(comp.baseTokens) || 0;
            var fileN = comp.segments.filter(function (s) { return s.kind === 'attachment' || s.kind === 'instruction'; }).length;
            function fileLink(pathStr, labelStr) {
                var name = escapeHtml(String(labelStr || ''));
                return (pathStr)
                    ? '<a href="#" class="obs-comp-file" data-path="' + escapeHtml(String(pathStr)) + '" title="' + escapeHtml(String(pathStr)) + '">' + name + '</a>'
                    : '<span class="obs-comp-block">' + name + '</span>';
            }
            function row(cls, tokVal, nameHtml) {
                return '<div class="obs-comp-row ' + cls + '">' +
                    '<span class="obs-comp-tok">' + tok(Number(tokVal) || 0) + '</span>' +
                    '<span class="obs-comp-name">' + nameHtml + '</span></div>';
            }
            var rows = '';
            for (var i = 0; i < comp.segments.length; i++) {
                var s = comp.segments[i];
                var ws = s.workspaceFolder ? '<span class="obs-comp-ws">' + escapeHtml(String(s.workspaceFolder)) + '</span>' : '';
                rows += row('obs-comp-' + escapeHtml(String(s.kind)), s.tokens, fileLink(s.path, s.label) + ws);
                // Itemized catalog children (skills/agents) shown inline — no nested expansion.
                var kids = Array.isArray(s.children) ? s.children : null;
                if (kids && kids.length && (s.kind === 'skills' || s.kind === 'agents')) {
                    for (var j = 0; j < kids.length; j++) {
                        var c = kids[j];
                        rows += row('obs-comp-child', c.tokens, fileLink(c.path, c.label));
                    }
                }
            }
            // Copilot's own base instructions + framing (closed) — accounted by size only.
            rows += row('obs-comp-base', baseC, '<span class="obs-comp-block">Copilot base + framing (injected)</span>');
            return '<div class="obs-comp">' +
                '<div class="obs-comp-header">System prompt composition \u2014 ' + fileN + ' file' + (fileN === 1 ? '' : 's') +
                ' \u00b7 ' + tok(totalC) + ' tok</div>' +
                '<div class="obs-comp-list">' + rows + '</div></div>';
        }

        // ── This turn: chronological timeline — LLM rows in columns, tool rows expandable ──
        var eventTbody = document.getElementById('obs-turn-event-tbody');
        if (eventTbody) {
            var events = observabilityMetrics.turnEvents || [];
            if (!events.length && observabilityMetrics.turnRequests && observabilityMetrics.turnRequests.length) {
                events = observabilityMetrics.turnRequests.map(function (req) {
                    var copy = Object.assign({}, req);
                    copy.kind = 'request';
                    return copy;
                });
            }
            // Preserve which tool rows / request rows are currently expanded across 2s re-renders.
            var openIds = {};
            var openNodes = eventTbody.querySelectorAll('details[open]');
            for (var oi = 0; oi < openNodes.length; oi++) {
                openIds[openNodes[oi].getAttribute('data-eid')] = true;
            }
            var openReqNodes = eventTbody.querySelectorAll('tr.obs-detail-row.obs-open');
            for (var ori = 0; ori < openReqNodes.length; ori++) {
                openIds[openReqNodes[ori].getAttribute('data-for')] = true;
            }
            if (!events.length) {
                eventTbody.innerHTML = '<tr><td colspan="7" class="obs-na">No events yet</td></tr>';
            } else {
                // Build one HTML <tr> (+ optional detail row) for a single tool event.
                var buildToolRow = function (ev, k) {
                    var eid = 't:' + String(ev.id || '') + ':' + k;
                    var openAttr = openIds[eid] ? ' open' : '';
                    var statusOk = !(ev.status && ev.status !== 'ok' && ev.status !== 'success');
                    var timeCls = statusOk ? 'obs-tl-time' : 'obs-tl-time obs-cache-risk';
                    // Flag heavy tool INPUT (>1K) and heavy tool OUTPUT (>4K). A large tool output
                    // is the bigger cost driver: it is appended to the conversation history and
                    // re-sent (billed) on every subsequent request until compaction.
                    var inHeavy = (Number(ev.inputTokens) || 0) > 1000;
                    var outHeavy = (Number(ev.outputTokens) || 0) > 4000;
                    var toolHeavy = inHeavy || outHeavy;
                    var isSubagent = String(ev.tool || '') === 'runSubagent';
                    var toolRowCls = 'obs-event-tool' + (toolHeavy ? ' obs-row-flag' : '') + (isSubagent ? ' obs-row-subagent' : '');
                    var subagentBadge = isSubagent ? '<span class="obs-kind-tag obs-tag-subagent" title="Sub-agent invocation \u2014 its nested model calls are billed as regular requests">sub-agent</span> ' : '';
                    return '<tr class="' + toolRowCls + '"><td colspan="7" class="obs-tool-cell">' +
                        '<details class="obs-tl-item obs-tl-tool" data-eid="' + eid + '"' + openAttr + '>' +
                        '<summary class="obs-tl-head">' +
                        '<span class="obs-tl-kind">tool</span>' +
                        '<span class="obs-tl-name">' + subagentBadge + '<span class="obs-req-id">' + escapeHtml(String(ev.id || '?')) + '</span> ' + escapeHtml(String(ev.tool || 'unknown')) + '</span>' +
                        '<span class="obs-tl-metric" title="input tokens">\u2193' + tok(ev.inputTokens) + '</span>' +
                        '<span class="obs-tl-metric' + (outHeavy ? ' obs-cache-risk' : '') + '" title="output tokens \u2014 large tool output is re-billed in history until compaction">\u2191' + tok(ev.outputTokens) + '</span>' +
                        '<span class="' + timeCls + '" title="duration">' + sec(ev.durMs) + 's</span>' +
                        '</summary>' +
                        '<div class="obs-tl-body">' +
                        '<div class="obs-tl-field"><span class="obs-tl-label">Input</span><pre class="obs-tl-pre">' + escapeHtml(String(ev.inputPreview || '\u2013')) + '</pre></div>' +
                        '<div class="obs-tl-field"><span class="obs-tl-label">Output</span><pre class="obs-tl-pre">' + escapeHtml(String(ev.outputPreview || '\u2013')) + '</pre></div>' +
                        '<div class="obs-tl-meta">status ' + escapeHtml(String(ev.status || 'ok')) + ' \u00b7 group ' + escapeHtml(String(ev.group || 'default')) + '</div>' +
                        '</div></details>' +
                        '</td></tr>';
                };
                // Build one HTML request <tr> (+ optional expandable detail row).
                var buildRequestRow = function (ev, k) {
                    var reid = 'r:' + String(ev.id || '') + ':' + k;
                    var isOpen = !!openIds[reid];
                    var inp = Number(ev.inputTokens) || 0;
                    var pct = inp > 0 ? Math.round((Number(ev.cachedTokens) || 0) / inp * 100) : 100;
                    var missed = (inp > 0 && pct < 50);
                    var bigOut = (Number(ev.outputTokens) || 0) > 1000;
                    var bigCredit = ((Number(ev.nanoAiu) || 0) / 1e9) > 100;
                    var hitCls = missed ? ' class="obs-cache-risk"' : '';
                    var outCls = bigOut ? ' class="obs-cache-risk"' : '';
                    var credCls = bigCredit ? ' class="obs-cache-risk"' : '';
                    var hasSplit = !!ev.split;
                    var reqRowCls = 'obs-event-request' +
                        ((missed || bigOut || bigCredit) ? ' obs-row-flag' : '') +
                        (ev.subagent ? ' obs-row-subagent-req' : '') +
                        (hasSplit ? ' obs-clickable' : '') +
                        (isOpen ? ' obs-expanded' : '');
                    var caret = hasSplit ? '<span class="obs-caret">\u25B8</span>' : '<span class="obs-caret-spacer"></span>';
                    var subTag = ev.firstOfTurn ? '<span class="obs-sub-tag" title="This turn\u2019s initiating request \u2014 your submission">submission</span> ' : '';
                    var kindTag = '';
                    if (ev.kindTag === 'compaction') { kindTag = '<span class="obs-kind-tag obs-tag-compaction" title="Context compaction (summarizeConversationHistory) \u2014 billed as a request">compaction</span> '; }
                    else if (ev.kindTag === 'retry') { kindTag = '<span class="obs-kind-tag obs-tag-retry" title="Retried request \u2014 billed again">retry</span> '; }
                    var html = '<tr class="' + reqRowCls + '" data-eid="' + reid + '">' +
                        '<td>' + caret + '<span class="obs-req-id">' + escapeHtml(String(ev.id || '?')) + '</span></td>' +
                        '<td class="obs-scope">' + subTag + kindTag + escapeHtml(String(ev.model || 'unknown')) + '</td>' +
                        '<td' + credCls + '>' + aiu(ev.nanoAiu) + '</td>' +
                        '<td>' + tok(ev.inputTokens) + '</td>' +
                        '<td' + outCls + '>' + tok(ev.outputTokens) + '</td>' +
                        '<td>' + tok(ev.cachedTokens) + '</td>' +
                        '<td' + hitCls + '>' + pct + '%</td></tr>';
                    if (hasSplit) {
                        html += '<tr class="obs-detail-row' + (isOpen ? ' obs-open' : '') + '" data-for="' + reid + '"' +
                            (isOpen ? '' : ' style="display:none"') + '>' +
                            '<td colspan="7">' + renderSplitDetail(ev.split) + '</td></tr>';
                    }
                    return html;
                };
                var buildAnyRow = function (ev, k) {
                    return ev.kind === 'tool' ? buildToolRow(ev, k) : buildRequestRow(ev, k);
                };

                // Sub-agent summaries (authoritative totals once the parent runSubagent finishes).
                var saSummary = {};
                var saList = observabilityMetrics.turnSubagents || [];
                for (var si = 0; si < saList.length; si++) { saSummary[saList[si].subagentId] = saList[si]; }

                // Partition events into top-level items and per-sub-agent groups, keeping the
                // group anchored at the position of its first event so the timeline stays ordered.
                var renderItems = [];
                var groups = {};
                for (var k = 0; k < events.length; k++) {
                    var ev = events[k];
                    var said = ev.subagentId;
                    if (said) {
                        if (!groups[said]) {
                            groups[said] = { id: said, items: [], reqCount: 0, toolCount: 0, nano: 0, inTok: 0, outTok: 0, minTs: Number(ev.ts) || 0, maxTs: Number(ev.ts) || 0, models: {} };
                            renderItems.push({ type: 'group', id: said });
                        }
                        var g = groups[said];
                        g.items.push({ ev: ev, k: k });
                        if (ev.kind === 'tool') { g.toolCount++; g.outTok += Number(ev.outputTokens) || 0; }
                        else {
                            g.reqCount++; g.nano += Number(ev.nanoAiu) || 0; g.inTok += Number(ev.inputTokens) || 0; g.outTok += Number(ev.outputTokens) || 0;
                            var mdl = String(ev.model || 'unknown');
                            g.models[mdl] = (g.models[mdl] || 0) + 1;
                        }
                        var ets = Number(ev.ts) || 0;
                        if (ets && (!g.minTs || ets < g.minTs)) { g.minTs = ets; }
                        if (ets > g.maxTs) { g.maxTs = ets; }
                    } else {
                        renderItems.push({ type: 'event', ev: ev, k: k });
                    }
                }

                var eventRows = '';
                for (var ri = 0; ri < renderItems.length; ri++) {
                    var item = renderItems[ri];
                    if (item.type === 'event') {
                        eventRows += buildAnyRow(item.ev, item.k);
                        continue;
                    }
                    // Sub-agent group: one collapsible wrapper aggregating all nested LLM + tool calls.
                    var grp = groups[item.id];
                    var sum = saSummary[item.id] || null;
                    var gLabel = (sum && sum.label) ? sum.label : 'sub-agent';
                    var done = !!(sum && sum.done);
                    var gid = 'sa:' + item.id;
                    var gOpenAttr = openIds[gid] ? ' open' : '';
                    var gDurMs = done ? Number(sum.durMs) || 0 : Math.max(0, (grp.maxTs - grp.minTs));
                    var gOut = done ? (Number(sum.outputTokens) || grp.outTok) : grp.outTok;
                    var statusBad = sum && sum.status && sum.status !== 'ok' && sum.status !== 'success';
                    var stateBadge = done
                        ? (statusBad ? '<span class="obs-kind-tag obs-tag-retry" title="Sub-agent ended with an error">failed</span>' : '<span class="obs-sub-tag" title="Sub-agent completed">done</span>')
                        : '<span class="obs-kind-tag obs-tag-subagent obs-sa-running" title="Sub-agent still running \u2014 totals update live">running\u2026</span>';
                    var nestedRows = '';
                    grp.items.sort(function (a, b) { return (Number(a.ev.ts) || 0) - (Number(b.ev.ts) || 0); });
                    for (var gi = 0; gi < grp.items.length; gi++) { nestedRows += buildAnyRow(grp.items[gi].ev, grp.items[gi].k); }
                    // Dominant model this sub-agent ran on (helps decide if a cheaper model would do).
                    var domModel = '', domN = -1;
                    for (var mk in grp.models) { if (grp.models[mk] > domN) { domN = grp.models[mk]; domModel = mk; } }
                    var modelBadge = domModel ? '<span class="obs-tl-metric" title="model this sub-agent ran on \u2014 delegate to a cheaper model to cut cost">' + escapeHtml(domModel) + '</span>' : '';
                    eventRows += '<tr class="obs-event-tool obs-row-subagent"><td colspan="7" class="obs-tool-cell">' +
                        '<details class="obs-tl-item obs-tl-subagent" data-eid="' + gid + '"' + gOpenAttr + '>' +
                        '<summary class="obs-tl-head">' +
                        '<span class="obs-tl-kind obs-tag-subagent">sub-agent</span>' +
                        '<span class="obs-tl-name"><span class="obs-req-id">' + escapeHtml(String(item.id)) + '</span> ' + escapeHtml(String(gLabel)) + ' ' + stateBadge + '</span>' +
                        modelBadge +
                        '<span class="obs-tl-metric" title="nested LLM requests / tool calls">' + grp.reqCount + ' req \u00b7 ' + grp.toolCount + ' tools</span>' +
                        '<span class="obs-tl-metric" title="credits (AIU)">' + aiu(grp.nano) + ' AIU</span>' +
                        '<span class="obs-tl-metric" title="output tokens">\u2191' + tok(gOut) + '</span>' +
                        '<span class="obs-tl-time" title="total wall time">' + sec(gDurMs) + 's</span>' +
                        '</summary>' +
                        '<div class="obs-tl-body obs-tl-subagent-body">' +
                        '<table class="observability-table obs-timeline-table obs-subagent-nested"><tbody>' + nestedRows + '</tbody></table>' +
                        '</div></details>' +
                        '</td></tr>';
                }
                eventTbody.innerHTML = eventRows;
            }
            // Delegated click: toggle a request row's detail row (bound once).
            if (!eventTbody._obsClickBound) {
                eventTbody._obsClickBound = true;
                eventTbody.addEventListener('click', function (e) {
                    var fileLink = e.target && e.target.closest ? e.target.closest('a.obs-comp-file') : null;
                    if (fileLink && eventTbody.contains(fileLink)) {
                        e.preventDefault();
                        var fp = fileLink.getAttribute('data-path');
                        if (fp) { vscode.postMessage({ type: 'openFile', path: fp }); }
                        return;
                    }
                    var row = e.target && e.target.closest ? e.target.closest('tr.obs-clickable') : null;
                    if (!row || !eventTbody.contains(row)) { return; }
                    var forId = row.getAttribute('data-eid');
                    var detail = eventTbody.querySelector('tr.obs-detail-row[data-for="' + forId + '"]');
                    if (!detail) { return; }
                    var nowOpen = detail.style.display === 'none';
                    detail.style.display = nowOpen ? '' : 'none';
                    detail.classList.toggle('obs-open', nowOpen);
                    row.classList.toggle('obs-expanded', nowOpen);
                });
            }
        }
        var turnSummary = document.getElementById('obs-turn-summary');
        if (turnSummary) {
            var lastScope = observabilityMetrics.lastRequest || {};
            var n = Number(lastScope.requestCount) || 0;
            var usd = ((Number(lastScope.nanoAiu) || 0) / 1e9 / 100);
            var usdStr = '<span style="color:#f14c4c">($' + usd.toFixed(2) + ')</span>';
            // Derive compaction / sub-agent counts from this turn's timeline events.
            var turnEvts = observabilityMetrics.turnEvents || [];
            var compactN = 0;
            for (var te = 0; te < turnEvts.length; te++) {
                var tev = turnEvts[te];
                if (tev.kind === 'request' && tev.kindTag === 'compaction') { compactN++; }
            }
            var subagentN = (observabilityMetrics.turnSubagents || []).length;
            var extra = '';
            if (compactN) { extra += ' \u00b7 <span class="obs-tag-compaction">' + compactN + ' compaction' + (compactN === 1 ? '' : 's') + '</span>'; }
            if (subagentN) { extra += ' \u00b7 <span class="obs-tag-subagent">' + subagentN + ' sub-agent' + (subagentN === 1 ? '' : 's') + '</span>'; }
            turnSummary.innerHTML = n
                ? (n + ' request' + (n === 1 ? '' : 's') + ' \u00b7 ' + aiu(lastScope.nanoAiu) + ' AIU ' + usdStr + ' \u00b7 ' +
                    tok(lastScope.inputTokens) + ' in / ' + tok(lastScope.outputTokens) + ' out \u00b7 ' + hitPct(lastScope) + ' cache hit' + extra)
                : 'No requests yet this turn';
        }
        // Live prompt-cache age clock: ticks up client-side from the last request ts. The Anthropic
        // prefix cache stays warm ~5 min; once cold, the next message likely pays a cache MISS. A
        // long-running tool also ages this (no new request logged), so it doubles as a "is the tool
        // taking so long the cache will be cold?" signal.
        if (!window._obsCacheAgeTimer) {
            window._obsCacheAgeTimer = setInterval(renderCacheAge, 1000);
        }
        renderCacheAge();
        var pingBtn = document.getElementById('obs-cache-ping-btn');
        if (pingBtn && !pingBtn._bound) {
            pingBtn._bound = true;
            pingBtn.addEventListener('click', function () {
                pingBtn.disabled = true;
                pingBtn.textContent = '\u26a1 Pinging\u2026';
                vscode.postMessage({ type: 'pingCache' });
                // Keep the user in AskAway's own input so their in-progress text is never lost
                // (the ping submits into the Copilot panel, not this box).
                setTimeout(function () { try { if (chatInput) { chatInput.focus(); } } catch (e) { /* ignore */ } }, 250);
                setTimeout(function () { pingBtn.disabled = false; pingBtn.textContent = '\u26a1 Ping'; }, 4000);
            });
        }
        renderToolTable('obs-turn-tool-tbody', tc.turn || {});

        // ── This month: consolidated totals + per-model + tools ──
        setCell('obs-all-reqs', num(all.requestCount));
        setCell('obs-all-credits', aiu(all.nanoAiu));
        setCell('obs-all-input', tok(all.inputTokens));
        setCell('obs-all-output', tok(all.outputTokens));
        setCell('obs-all-cached', tok(all.cachedTokens));
        setHit('obs-all-hit', all);
        setCell('obs-all-miss', num(all.cacheMisses || 0));
        var comp = observabilityMetrics.overallCompaction || { count: 0, nanoAiu: 0 };
        var compEl = document.getElementById('obs-all-compaction');
        if (compEl) {
            var cc = Number(comp.count) || 0;
            compEl.innerHTML = cc
                ? 'Compaction: <span class="obs-tag-compaction">' + num(cc) + ' request' + (cc === 1 ? '' : 's') + '</span> \u00b7 ' + aiu(comp.nanoAiu) + ' AIU spent auto-summarizing context this month'
                : 'Compaction: 0 requests this month';
        }
        renderToolTable('obs-month-tool-tbody', tc);

        if (observabilityRtkLine) {
            observabilityRtkLine.textContent = 'RTK: ' + num(observabilityMetrics.rtkCommandCount) +
                ' calls \u00b7 ' + tok(observabilityMetrics.rtkSavedTokens) + ' saved \u00b7 ' +
                formatPercent(observabilityMetrics.rtkSavingsPct);
        }

        if (observabilityModelTbody) {
            var models = observabilityMetrics.perModel || [];
            if (!models.length) {
                observabilityModelTbody.innerHTML = '<tr><td colspan="6" class="obs-na">No data yet</td></tr>';
            } else {
                var rows = '';
                for (var i = 0; i < models.length; i++) {
                    var m = models[i];
                    rows += '<tr><td class="obs-scope">' + escapeHtml(String(m.model || 'unknown')) + '</td>' +
                        '<td>' + num(m.requestCount) + '</td>' +
                        '<td>' + aiu(m.nanoAiu) + '</td>' +
                        '<td>' + tok(m.inputTokens) + '</td>' +
                        '<td>' + tok(m.outputTokens) + '</td>' +
                        '<td>' + tok(m.cachedTokens) + '</td></tr>';
                }
                observabilityModelTbody.innerHTML = rows;
            }
        }

        var gradleLine = document.getElementById('observability-gradle-line');
        if (gradleLine) {
            var g = observabilityMetrics.gradle || {};
            gradleLine.textContent = 'Gradle: ' + num(g.runs) + ' runs \u00b7 ' + num(g.optimizedRuns) +
                ' optimized \u00b7 ~' + tok(g.savedTokens) + ' tokens saved' +
                (g.tasksAvoided ? ' \u00b7 ' + num(g.tasksAvoided) + ' tasks cached' : '') +
                (g.configCacheReuses ? ' \u00b7 ' + num(g.configCacheReuses) + ' cfg-cache reuse' : '');
        }
    }

    function renderMemoriesList() {
        if (observabilityMemoryCount) observabilityMemoryCount.textContent = String(memoriesList.length);
        if (!observabilityMemoryList) return;
        if (!memoriesList.length) {
            observabilityMemoryList.innerHTML = '<li class="obs-na">No memories yet</li>';
            return;
        }
        var html = '';
        for (var i = 0; i < memoriesList.length; i++) {
            var m = memoriesList[i];
            var when = m.modified ? new Date(m.modified).toLocaleDateString() : '';
            var kb = m.size ? (m.size >= 1024 ? Math.round(m.size / 1024) + 'K' : m.size + 'B') : '';
            html += '<li class="obs-mem-item" title="' + escapeHtml(String(m.file || '')) + '">' +
                '<span class="obs-mem-title">' + escapeHtml(String(m.title || m.file || 'memory')) + '</span>' +
                '<span class="obs-mem-meta">' + escapeHtml(when) + (kb ? ' \u00b7 ' + kb : '') + '</span></li>';
        }
        observabilityMemoryList.innerHTML = html;
    }

    function formatObservabilityNumber(value) {
        var n = Number(value);
        if (!isFinite(n)) {
            return '0';
        }
        return Math.round(n).toLocaleString();
    }

    function formatObservabilityCompact(value) {
        var n = Number(value);
        if (!isFinite(n)) {
            return '0';
        }

        var sign = n < 0 ? '-' : '';
        var abs = Math.abs(n);

        if (abs >= 1000000) {
            return sign + compactWithSuffix(abs / 1000000, 'M');
        }
        if (abs >= 1000) {
            return sign + compactWithSuffix(abs / 1000, 'K');
        }
        return sign + Math.round(abs).toLocaleString();
    }

    function compactWithSuffix(value, suffix) {
        var decimals = value >= 100 ? 0 : 2;
        var rounded = value.toFixed(decimals).replace(/\.0+$/, '');
        return rounded + suffix;
    }

    function formatPercent(value) {
        var n = Number(value);
        if (!isFinite(n)) {
            return '0%';
        }
        var rounded = (Math.round(n * 100) / 100).toFixed(2).replace(/\.0+$/, '');
        return rounded + '%';
    }

    function normalizeResponseTimeout(value) {
        if (!Number.isFinite(value)) {
            return RESPONSE_TIMEOUT_DEFAULT;
        }
        if (!RESPONSE_TIMEOUT_ALLOWED_VALUES.has(value)) {
            return RESPONSE_TIMEOUT_DEFAULT;
        }
        return value;
    }

    function handleResponseTimeoutChange() {
        if (!responseTimeoutSelect) return;
        var value = parseInt(responseTimeoutSelect.value, 10);
        console.log('[AskAway] Response timeout changed to:', value);
        if (!isNaN(value)) {
            responseTimeout = value;
            vscode.postMessage({ type: 'updateResponseTimeout', value: value });
        }
    }

    function updateResponseTimeoutUI() {
        if (!responseTimeoutSelect) return;
        responseTimeoutSelect.value = String(responseTimeout);
    }

    function handleSessionWarningHoursChange() {
        if (!sessionWarningHoursSelect) return;
        var value = parseInt(sessionWarningHoursSelect.value, 10);
        if (!isNaN(value) && value >= 0 && value <= 8) {
            sessionWarningHours = value;
            vscode.postMessage({ type: 'updateSessionWarningHours', value: value });
        }
        sessionWarningHoursSelect.value = String(sessionWarningHours);
    }

    function updateSessionWarningHoursUI() {
        if (!sessionWarningHoursSelect) return;
        sessionWarningHoursSelect.value = String(sessionWarningHours);
    }

    function handleMaxAutoResponsesChange() {
        if (!maxAutoResponsesInput) return;
        var value = parseInt(maxAutoResponsesInput.value, 10);
        if (!isNaN(value) && value >= 1 && value <= 50) {
            maxConsecutiveAutoResponses = value;
            vscode.postMessage({ type: 'updateMaxConsecutiveAutoResponses', value: value });
        } else {
            // Reset to valid value
            maxAutoResponsesInput.value = maxConsecutiveAutoResponses;
        }
    }

    function updateMaxAutoResponsesUI() {
        if (!maxAutoResponsesInput) return;
        maxAutoResponsesInput.value = maxConsecutiveAutoResponses;
    }

    function handleTurnBudgetChange() {
        if (!turnBudgetInput) return;
        var value = parseInt(turnBudgetInput.value, 10);
        if (isNaN(value) || value < 0) { value = 0; }
        turnBudgetAiu = value;
        turnBudgetInput.value = value;
        vscode.postMessage({ type: 'updateTurnBudgetAiu', value: value });
    }

    function updateTurnBudgetUI() {
        if (!turnBudgetInput) return;
        turnBudgetInput.value = turnBudgetAiu;
    }

    function toggleHumanDelaySetting() {
        humanLikeDelayEnabled = !humanLikeDelayEnabled;
        vscode.postMessage({ type: 'updateHumanDelaySetting', enabled: humanLikeDelayEnabled });
        updateHumanDelayUI();
    }

    function handleHumanDelayMinChange() {
        if (!humanDelayMinInput) return;
        var value = parseInt(humanDelayMinInput.value, 10);
        if (!isNaN(value) && value >= 1 && value <= 30) {
            if (value > humanLikeDelayMax) {
                value = humanLikeDelayMax;
            }
            humanLikeDelayMin = value;
            vscode.postMessage({ type: 'updateHumanDelayMin', value: value });
        }
        humanDelayMinInput.value = humanLikeDelayMin;
    }

    function handleHumanDelayMaxChange() {
        if (!humanDelayMaxInput) return;
        var value = parseInt(humanDelayMaxInput.value, 10);
        if (!isNaN(value) && value >= 2 && value <= 60) {
            if (value < humanLikeDelayMin) {
                value = humanLikeDelayMin;
            }
            humanLikeDelayMax = value;
            vscode.postMessage({ type: 'updateHumanDelayMax', value: value });
        }
        humanDelayMaxInput.value = humanLikeDelayMax;
    }

    function updateHumanDelayUI() {
        if (humanDelayToggle) {
            humanDelayToggle.classList.toggle('active', humanLikeDelayEnabled);
            humanDelayToggle.setAttribute('aria-checked', humanLikeDelayEnabled ? 'true' : 'false');
        }
        if (humanDelayRangeContainer) {
            humanDelayRangeContainer.style.display = humanLikeDelayEnabled ? 'flex' : 'none';
        }
        if (humanDelayMinInput) {
            humanDelayMinInput.value = humanLikeDelayMin;
        }
        if (humanDelayMaxInput) {
            humanDelayMaxInput.value = humanLikeDelayMax;
        }
    }

    // ========== Autopilot Prompts Array Functions ==========

    // Track which autopilot prompt is being edited (-1 = adding new, >= 0 = editing index)
    var editingAutopilotPromptIndex = -1;
    // Track drag state
    var draggedAutopilotIndex = -1;

    function renderAutopilotPromptsList() {
        if (!autopilotPromptsList) return;

        if (autopilotPrompts.length === 0) {
            autopilotPromptsList.innerHTML = '<div class="empty-prompts-hint">No prompts added. Add prompts to cycle through during Autopilot.</div>';
            return;
        }

        autopilotPromptsList.innerHTML = autopilotPrompts.map(function (prompt, index) {
            var truncated = prompt.length > 80 ? prompt.substring(0, 80) + '...' : prompt;
            var tooltipText = prompt.length > 300 ? prompt.substring(0, 300) + '...' : prompt;
            tooltipText = tooltipText.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return '<div class="autopilot-prompt-item" draggable="true" data-index="' + index + '" title="' + tooltipText + '">' +
                '<span class="autopilot-prompt-drag-handle codicon codicon-grabber"></span>' +
                '<span class="autopilot-prompt-number">' + (index + 1) + '.</span>' +
                '<span class="autopilot-prompt-text">' + escapeHtml(truncated) + '</span>' +
                '<div class="autopilot-prompt-actions">' +
                '<button class="prompt-item-btn edit" data-index="' + index + '" title="Edit"><span class="codicon codicon-edit"></span></button>' +
                '<button class="prompt-item-btn delete" data-index="' + index + '" title="Delete"><span class="codicon codicon-trash"></span></button>' +
                '</div></div>';
        }).join('');
    }

    function showAddAutopilotPromptForm() {
        if (!addAutopilotPromptForm || !autopilotPromptInput) return;
        editingAutopilotPromptIndex = -1;
        autopilotPromptInput.value = '';
        addAutopilotPromptForm.classList.remove('hidden');
        addAutopilotPromptForm.removeAttribute('data-editing-index');
        autopilotPromptInput.focus();
    }

    function hideAddAutopilotPromptForm() {
        if (!addAutopilotPromptForm || !autopilotPromptInput) return;
        addAutopilotPromptForm.classList.add('hidden');
        autopilotPromptInput.value = '';
        editingAutopilotPromptIndex = -1;
        addAutopilotPromptForm.removeAttribute('data-editing-index');
    }

    function saveAutopilotPrompt() {
        if (!autopilotPromptInput) return;
        var prompt = autopilotPromptInput.value.trim();
        if (!prompt) return;

        var editingIndex = addAutopilotPromptForm.getAttribute('data-editing-index');
        if (editingIndex !== null) {
            vscode.postMessage({ type: 'editAutopilotPrompt', index: parseInt(editingIndex, 10), prompt: prompt });
        } else {
            vscode.postMessage({ type: 'addAutopilotPrompt', prompt: prompt });
        }
        hideAddAutopilotPromptForm();
    }

    function handleAutopilotPromptsListClick(e) {
        var target = e.target.closest('.prompt-item-btn');
        if (!target) return;

        var index = parseInt(target.getAttribute('data-index'), 10);
        if (isNaN(index)) return;

        if (target.classList.contains('edit')) {
            editAutopilotPrompt(index);
        } else if (target.classList.contains('delete')) {
            deleteAutopilotPrompt(index);
        }
    }

    function editAutopilotPrompt(index) {
        if (index < 0 || index >= autopilotPrompts.length) return;
        if (!addAutopilotPromptForm || !autopilotPromptInput) return;

        var prompt = autopilotPrompts[index];
        editingAutopilotPromptIndex = index;
        autopilotPromptInput.value = prompt;
        addAutopilotPromptForm.setAttribute('data-editing-index', index);
        addAutopilotPromptForm.classList.remove('hidden');
        autopilotPromptInput.focus();
    }

    function deleteAutopilotPrompt(index) {
        if (index < 0 || index >= autopilotPrompts.length) return;
        vscode.postMessage({ type: 'removeAutopilotPrompt', index: index });
    }

    function handleAutopilotDragStart(e) {
        var item = e.target.closest('.autopilot-prompt-item');
        if (!item) return;
        draggedAutopilotIndex = parseInt(item.getAttribute('data-index'), 10);
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedAutopilotIndex);
    }

    function handleAutopilotDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        var item = e.target.closest('.autopilot-prompt-item');
        if (!item || !autopilotPromptsList) return;

        autopilotPromptsList.querySelectorAll('.autopilot-prompt-item').forEach(function (el) {
            el.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        var rect = item.getBoundingClientRect();
        var midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
            item.classList.add('drag-over-top');
        } else {
            item.classList.add('drag-over-bottom');
        }
    }

    function handleAutopilotDragEnd(e) {
        draggedAutopilotIndex = -1;
        if (!autopilotPromptsList) return;
        autopilotPromptsList.querySelectorAll('.autopilot-prompt-item').forEach(function (el) {
            el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
        });
    }

    function handleAutopilotDrop(e) {
        e.preventDefault();
        var item = e.target.closest('.autopilot-prompt-item');
        if (!item || draggedAutopilotIndex < 0) return;

        var toIndex = parseInt(item.getAttribute('data-index'), 10);
        if (isNaN(toIndex) || draggedAutopilotIndex === toIndex) {
            handleAutopilotDragEnd(e);
            return;
        }

        var rect = item.getBoundingClientRect();
        var midY = rect.top + rect.height / 2;
        var insertBelow = e.clientY >= midY;

        var targetIndex = toIndex;
        if (insertBelow && toIndex < autopilotPrompts.length - 1) {
            targetIndex = toIndex + 1;
        }

        if (draggedAutopilotIndex < targetIndex) {
            targetIndex--;
        }

        if (draggedAutopilotIndex !== targetIndex) {
            vscode.postMessage({ type: 'reorderAutopilotPrompts', fromIndex: draggedAutopilotIndex, toIndex: targetIndex });
        }

        handleAutopilotDragEnd(e);
    }

    // ========== End Autopilot Prompts Functions ==========

    /**
     * Handle send action triggered by VS Code command/keybinding.
     */
    function handleSendFromShortcut() {
        if (!chatInput || document.activeElement !== chatInput) {
            return;
        }

        if (isApprovalQuestion && approvalModal && !approvalModal.classList.contains('hidden')) {
            var inputText = chatInput.value.trim();
            if (!inputText) {
                handleApprovalContinue();
                return;
            }
        }

        if (editingPromptId) {
            confirmEditMode();
            return;
        }

        if (slashDropdownVisible && selectedSlashIndex >= 0) {
            selectSlashItem(selectedSlashIndex);
            return;
        }

        if (autocompleteVisible && selectedAutocompleteIndex >= 0) {
            selectAutocompleteItem(selectedAutocompleteIndex);
            return;
        }

        handleSend();
    }

    /**
     * Capture latest right-click position for context-menu copy resolution.
     */
    function handleContextMenu(event) {
        if (!event || !event.target || !event.target.closest) {
            lastContextMenuTarget = null;
            lastContextMenuTimestamp = 0;
            return;
        }

        lastContextMenuTarget = event.target;
        lastContextMenuTimestamp = Date.now();
    }

    /**
     * Override Copy when nothing is selected and context-menu target points to a message.
     */
    function handleCopy(event) {
        var selection = window.getSelection ? window.getSelection() : null;
        if (selection && selection.toString().length > 0) {
            return;
        }

        if (!lastContextMenuTarget || (Date.now() - lastContextMenuTimestamp) > CONTEXT_MENU_COPY_MAX_AGE_MS) {
            return;
        }

        var copyText = resolveCopyTextFromTarget(lastContextMenuTarget);
        if (!copyText) {
            return;
        }

        if (event) {
            event.preventDefault();
        }

        if (event && event.clipboardData) {
            try {
                event.clipboardData.setData('text/plain', copyText);
                lastContextMenuTarget = null;
                lastContextMenuTimestamp = 0;
                return;
            } catch (error) {
                // Fall through to extension host clipboard API fallback.
            }
        }

        vscode.postMessage({ type: 'copyToClipboard', text: copyText });
        lastContextMenuTarget = null;
        lastContextMenuTimestamp = 0;
    }

    /**
     * Resolve copy payload from the exact message area that was right-clicked.
     */
    function resolveCopyTextFromTarget(target) {
        if (!target || !target.closest) {
            return '';
        }

        var pendingQuestion = target.closest('.pending-ai-question');
        if (pendingQuestion) {
            if (pendingToolCall && typeof pendingToolCall.prompt === 'string') {
                return pendingToolCall.prompt;
            }
            return (pendingQuestion.textContent || '').trim();
        }

        var toolCallEntry = resolveToolCallEntryFromTarget(target);
        if (!toolCallEntry) {
            return '';
        }

        if (target.closest('.tool-call-ai-response')) {
            return typeof toolCallEntry.prompt === 'string' ? toolCallEntry.prompt : '';
        }

        if (target.closest('.tool-call-user-response')) {
            return typeof toolCallEntry.response === 'string' ? toolCallEntry.response : '';
        }

        if (target.closest('.chips-container')) {
            return formatAttachmentsForCopy(toolCallEntry.attachments);
        }

        return formatToolCallEntryForCopy(toolCallEntry);
    }

    function resolveToolCallEntryFromTarget(target) {
        var card = target.closest('.tool-call-card');
        if (!card) {
            return null;
        }
        return resolveToolCallEntryFromCardId(card.getAttribute('data-id'));
    }

    function resolveToolCallEntryFromCardId(cardId) {
        if (!cardId) {
            return null;
        }
        // Check current session first
        for (var i = 0; i < currentSessionCalls.length; i++) {
            if (currentSessionCalls[i].id === cardId) return currentSessionCalls[i];
        }
        // Check persisted history
        for (var h = 0; h < persistedHistory.length; h++) {
            var session = persistedHistory[h];
            if (session && session.calls) {
                for (var j = 0; j < session.calls.length; j++) {
                    if (session.calls[j].id === cardId) return session.calls[j];
                }
            }
        }
        return null;
    }

    function formatAttachmentsForCopy(attachments) {
        if (!attachments || attachments.length === 0) return '';
        return attachments.map(function (a) { return a.name || a.id || ''; }).filter(Boolean).join(', ');
    }

    function formatToolCallEntryForCopy(entry) {
        if (!entry) return '';
        var parts = [];
        if (entry.prompt) parts.push('Q: ' + entry.prompt);
        if (entry.response) parts.push('A: ' + entry.response);
        return parts.join('\n\n');
    }

    function showAddPromptForm() {
        if (!addPromptForm || !addPromptBtn) return;
        addPromptForm.classList.remove('hidden');
        addPromptBtn.classList.add('hidden');
        var nameInput = document.getElementById('prompt-name-input');
        var textInput = document.getElementById('prompt-text-input');
        if (nameInput) { nameInput.value = ''; nameInput.focus(); }
        if (textInput) textInput.value = '';
        // Clear edit mode
        addPromptForm.removeAttribute('data-editing-id');
    }

    function hideAddPromptForm() {
        if (!addPromptForm || !addPromptBtn) return;
        addPromptForm.classList.add('hidden');
        addPromptBtn.classList.remove('hidden');
        addPromptForm.removeAttribute('data-editing-id');
    }

    function saveNewPrompt() {
        var nameInput = document.getElementById('prompt-name-input');
        var textInput = document.getElementById('prompt-text-input');
        if (!nameInput || !textInput) return;

        var name = nameInput.value.trim();
        var prompt = textInput.value.trim();

        if (!name || !prompt) {
            return;
        }

        var editingId = addPromptForm.getAttribute('data-editing-id');
        if (editingId) {
            // Editing existing prompt
            vscode.postMessage({ type: 'editReusablePrompt', id: editingId, name: name, prompt: prompt });
        } else {
            // Adding new prompt
            vscode.postMessage({ type: 'addReusablePrompt', name: name, prompt: prompt });
        }

        hideAddPromptForm();
    }

    function renderPromptsList() {
        if (!promptsList) return;

        if (reusablePrompts.length === 0) {
            promptsList.innerHTML = '';
            return;
        }

        // Compact list - show only name, full prompt on hover via title
        promptsList.innerHTML = reusablePrompts.map(function (p) {
            // Truncate very long prompts for tooltip to prevent massive tooltips
            var tooltipText = p.prompt.length > 300 ? p.prompt.substring(0, 300) + '...' : p.prompt;
            // Escape for HTML attribute
            tooltipText = tooltipText.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return '<div class="prompt-item compact" data-id="' + escapeHtml(p.id) + '" title="' + tooltipText + '">' +
                '<div class="prompt-item-content">' +
                '<span class="prompt-item-name">/' + escapeHtml(p.name) + '</span>' +
                '</div>' +
                '<div class="prompt-item-actions">' +
                '<button class="prompt-item-btn edit" data-id="' + escapeHtml(p.id) + '" title="Edit"><span class="codicon codicon-edit"></span></button>' +
                '<button class="prompt-item-btn delete" data-id="' + escapeHtml(p.id) + '" title="Delete"><span class="codicon codicon-trash"></span></button>' +
                '</div></div>';
        }).join('');

        // Bind edit/delete events
        promptsList.querySelectorAll('.prompt-item-btn.edit').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-id');
                editPrompt(id);
            });
        });

        promptsList.querySelectorAll('.prompt-item-btn.delete').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-id');
                deletePrompt(id);
            });
        });
    }

    function editPrompt(id) {
        var prompt = reusablePrompts.find(function (p) { return p.id === id; });
        if (!prompt) return;

        var nameInput = document.getElementById('prompt-name-input');
        var textInput = document.getElementById('prompt-text-input');
        if (!nameInput || !textInput) return;

        // Show form with existing values
        addPromptForm.classList.remove('hidden');
        addPromptBtn.classList.add('hidden');
        addPromptForm.setAttribute('data-editing-id', id);

        nameInput.value = prompt.name;
        textInput.value = prompt.prompt;
        nameInput.focus();
    }

    function deletePrompt(id) {
        vscode.postMessage({ type: 'removeReusablePrompt', id: id });
    }

    // ===== SLASH COMMAND FUNCTIONS =====

    /**
     * Expand /commandName patterns to their full prompt text
     * Only expands known commands at the start of lines or after whitespace
     */
    function expandSlashCommands(text) {
        if (!text || reusablePrompts.length === 0) return text;

        // Use stored mappings from selectSlashItem if available
        var mappings = chatInput && chatInput._slashPrompts ? chatInput._slashPrompts : {};

        // Build a regex to match all known prompt names
        var promptNames = reusablePrompts.map(function (p) { return p.name; });
        if (Object.keys(mappings).length > 0) {
            Object.keys(mappings).forEach(function (name) {
                if (promptNames.indexOf(name) === -1) promptNames.push(name);
            });
        }

        // Match /promptName at start or after whitespace
        var expanded = text;
        promptNames.forEach(function (name) {
            // Escape special regex chars in name
            var escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            var regex = new RegExp('(^|\\s)/' + escapedName + '(?=\\s|$)', 'g');
            var fullPrompt = mappings[name] || (reusablePrompts.find(function (p) { return p.name === name; }) || {}).prompt || '';
            if (fullPrompt) {
                expanded = expanded.replace(regex, '$1' + fullPrompt);
            }
        });

        // Clear stored mappings after expansion
        if (chatInput) chatInput._slashPrompts = {};

        return expanded.trim();
    }

    function handleSlashCommands() {
        if (!chatInput) return;
        var value = chatInput.value;
        var cursorPos = chatInput.selectionStart;

        // Find slash at start of input or after whitespace
        var slashPos = -1;
        for (var i = cursorPos - 1; i >= 0; i--) {
            if (value[i] === '/') {
                // Check if it's at start or after whitespace
                if (i === 0 || /\s/.test(value[i - 1])) {
                    slashPos = i;
                }
                break;
            }
            if (/\s/.test(value[i])) break;
        }

        if (slashPos >= 0 && reusablePrompts.length > 0) {
            var query = value.substring(slashPos + 1, cursorPos);
            slashStartPos = slashPos;
            if (slashDebounceTimer) clearTimeout(slashDebounceTimer);
            slashDebounceTimer = setTimeout(function () {
                // Filter locally for instant results
                var queryLower = query.toLowerCase();
                var matchingPrompts = reusablePrompts.filter(function (p) {
                    return p.name.toLowerCase().includes(queryLower) ||
                        p.prompt.toLowerCase().includes(queryLower);
                });
                showSlashDropdown(matchingPrompts);
            }, 50);
        } else if (slashDropdownVisible) {
            hideSlashDropdown();
        }
    }

    function showSlashDropdown(results) {
        if (!slashDropdown || !slashList || !slashEmpty) return;
        slashResults = results;
        selectedSlashIndex = results.length > 0 ? 0 : -1;

        // Hide file autocomplete if showing slash commands
        hideAutocomplete();

        if (results.length === 0) {
            slashList.classList.add('hidden');
            slashEmpty.classList.remove('hidden');
        } else {
            slashList.classList.remove('hidden');
            slashEmpty.classList.add('hidden');
            renderSlashList();
        }
        slashDropdown.classList.remove('hidden');
        slashDropdownVisible = true;
    }

    function hideSlashDropdown() {
        if (slashDropdown) slashDropdown.classList.add('hidden');
        slashDropdownVisible = false;
        slashResults = [];
        selectedSlashIndex = -1;
        slashStartPos = -1;
        if (slashDebounceTimer) { clearTimeout(slashDebounceTimer); slashDebounceTimer = null; }
    }

    function renderSlashList() {
        if (!slashList) return;
        slashList.innerHTML = slashResults.map(function (p, index) {
            var truncatedPrompt = p.prompt.length > 50 ? p.prompt.substring(0, 50) + '...' : p.prompt;
            // Prepare tooltip text - escape for HTML attribute
            var tooltipText = p.prompt.length > 500 ? p.prompt.substring(0, 500) + '...' : p.prompt;
            tooltipText = tooltipText.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return '<div class="slash-item' + (index === selectedSlashIndex ? ' selected' : '') + '" data-index="' + index + '" data-tooltip="' + tooltipText + '">' +
                '<span class="slash-item-icon"><span class="codicon codicon-symbol-keyword"></span></span>' +
                '<div class="slash-item-content">' +
                '<span class="slash-item-name">/' + escapeHtml(p.name) + '</span>' +
                '<span class="slash-item-preview">' + escapeHtml(truncatedPrompt) + '</span>' +
                '</div></div>';
        }).join('');

        slashList.querySelectorAll('.slash-item').forEach(function (item) {
            item.addEventListener('click', function () { selectSlashItem(parseInt(item.getAttribute('data-index'), 10)); });
            item.addEventListener('mouseenter', function () { selectedSlashIndex = parseInt(item.getAttribute('data-index'), 10); updateSlashSelection(); });
        });
        scrollToSelectedSlashItem();
    }

    function updateSlashSelection() {
        if (!slashList) return;
        slashList.querySelectorAll('.slash-item').forEach(function (item, index) {
            item.classList.toggle('selected', index === selectedSlashIndex);
        });
        scrollToSelectedSlashItem();
    }

    function scrollToSelectedSlashItem() {
        var selectedItem = slashList ? slashList.querySelector('.slash-item.selected') : null;
        if (selectedItem) selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function selectSlashItem(index) {
        if (index < 0 || index >= slashResults.length || !chatInput || slashStartPos < 0) return;
        var prompt = slashResults[index];
        var value = chatInput.value;
        var cursorPos = chatInput.selectionStart;

        // Create a slash tag representation - when sent, we'll expand it to full prompt
        // For now, insert /name as text and store the mapping
        var slashText = '/' + prompt.name + ' ';
        chatInput.value = value.substring(0, slashStartPos) + slashText + value.substring(cursorPos);
        var newCursorPos = slashStartPos + slashText.length;
        chatInput.setSelectionRange(newCursorPos, newCursorPos);

        // Store the prompt reference for expansion on send
        if (!chatInput._slashPrompts) chatInput._slashPrompts = {};
        chatInput._slashPrompts[prompt.name] = prompt.prompt;

        hideSlashDropdown();
        chatInput.focus();
        updateSendButtonState();
    }

    // ===== NOTIFICATION SOUND FUNCTION =====

    /**
     * Unlock audio playback after first user interaction
     * Required due to browser autoplay policy
     */
    function unlockAudioOnInteraction() {
        function unlock() {
            if (audioUnlocked) return;
            var audio = document.getElementById('notification-sound');
            if (audio) {
                // Play and immediately pause to unlock
                audio.volume = 0;
                var playPromise = audio.play();
                if (playPromise !== undefined) {
                    playPromise.then(function () {
                        audio.pause();
                        audio.currentTime = 0;
                        audio.volume = 0.5;
                        audioUnlocked = true;
                        console.log('[TaskSync] Audio unlocked successfully');
                    }).catch(function () {
                        // Still locked, will try again on next interaction
                    });
                }
            }
            // Remove listeners after first attempt
            document.removeEventListener('click', unlock);
            document.removeEventListener('keydown', unlock);
        }
        document.addEventListener('click', unlock, { once: true });
        document.addEventListener('keydown', unlock, { once: true });
    }

    function playNotificationSound() {
        console.log('[TaskSync] playNotificationSound called, audioUnlocked:', audioUnlocked);
        // Play the preloaded audio element
        try {
            var audio = document.getElementById('notification-sound');
            console.log('[TaskSync] Audio element found:', !!audio);
            if (audio) {
                audio.currentTime = 0; // Reset to beginning
                audio.volume = 0.5;
                console.log('[TaskSync] Attempting to play audio...');
                var playPromise = audio.play();
                if (playPromise !== undefined) {
                    playPromise.then(function () {
                        console.log('[TaskSync] Audio playback started successfully');
                    }).catch(function (e) {
                        console.log('[TaskSync] Could not play audio:', e.message);
                        console.log('[TaskSync] Error name:', e.name);
                        // If autoplay blocked, show visual feedback
                        flashNotification();
                    });
                }
            } else {
                console.log('[TaskSync] No audio element found, showing visual notification');
                flashNotification();
            }
        } catch (e) {
            console.log('[TaskSync] Could not play notification sound:', e);
            flashNotification();
        }
    }

    function flashNotification() {
        // Visual flash when audio fails
        var body = document.body;
        body.style.transition = 'background-color 0.1s ease';
        var originalBg = body.style.backgroundColor;
        body.style.backgroundColor = 'var(--vscode-textLink-foreground, #3794ff)';
        setTimeout(function () {
            body.style.backgroundColor = originalBg || '';
        }, 150);
    }

    function bindDragAndDrop() {
        if (!queueList) return;
        queueList.querySelectorAll('.queue-item').forEach(function (item) {
            item.addEventListener('dragstart', function (e) {
                e.dataTransfer.setData('text/plain', String(parseInt(item.getAttribute('data-index'), 10)));
                item.classList.add('dragging');
            });
            item.addEventListener('dragend', function () { item.classList.remove('dragging'); });
            item.addEventListener('dragover', function (e) { e.preventDefault(); item.classList.add('drag-over'); });
            item.addEventListener('dragleave', function () { item.classList.remove('drag-over'); });
            item.addEventListener('drop', function (e) {
                e.preventDefault();
                var fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
                var toIndex = parseInt(item.getAttribute('data-index'), 10);
                item.classList.remove('drag-over');
                if (fromIndex !== toIndex && !isNaN(fromIndex) && !isNaN(toIndex)) reorderQueue(fromIndex, toIndex);
            });
        });
    }

    function bindKeyboardNavigation() {
        if (!queueList) return;
        var items = queueList.querySelectorAll('.queue-item');
        items.forEach(function (item, index) {
            item.addEventListener('keydown', function (e) {
                if (e.key === 'ArrowDown' && index < items.length - 1) { e.preventDefault(); items[index + 1].focus(); }
                else if (e.key === 'ArrowUp' && index > 0) { e.preventDefault(); items[index - 1].focus(); }
                else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); var id = item.getAttribute('data-id'); if (id) removeFromQueue(id); }
            });
        });
    }

    function reorderQueue(fromIndex, toIndex) {
        var removed = promptQueue.splice(fromIndex, 1)[0];
        promptQueue.splice(toIndex, 0, removed);
        renderQueue();
        vscode.postMessage({ type: 'reorderQueue', fromIndex: fromIndex, toIndex: toIndex });
    }

    function handleAutocomplete() {
        if (!chatInput) return;
        var value = chatInput.value;
        var cursorPos = chatInput.selectionStart;
        var hashPos = -1;
        for (var i = cursorPos - 1; i >= 0; i--) {
            if (value[i] === '#') { hashPos = i; break; }
            if (value[i] === ' ' || value[i] === '\n') break;
        }
        if (hashPos >= 0) {
            var query = value.substring(hashPos + 1, cursorPos);
            autocompleteStartPos = hashPos;
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(function () {
                vscode.postMessage({ type: 'searchFiles', query: query });
            }, 150);
        } else if (autocompleteVisible) {
            hideAutocomplete();
        }
    }

    function showAutocomplete(results) {
        if (!autocompleteDropdown || !autocompleteList || !autocompleteEmpty) return;
        autocompleteResults = results;
        selectedAutocompleteIndex = results.length > 0 ? 0 : -1;
        if (results.length === 0) {
            autocompleteList.classList.add('hidden');
            autocompleteEmpty.classList.remove('hidden');
        } else {
            autocompleteList.classList.remove('hidden');
            autocompleteEmpty.classList.add('hidden');
            renderAutocompleteList();
        }
        autocompleteDropdown.classList.remove('hidden');
        autocompleteVisible = true;
    }

    function hideAutocomplete() {
        if (autocompleteDropdown) autocompleteDropdown.classList.add('hidden');
        autocompleteVisible = false;
        autocompleteResults = [];
        selectedAutocompleteIndex = -1;
        autocompleteStartPos = -1;
        if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
    }

    function renderAutocompleteList() {
        if (!autocompleteList) return;
        autocompleteList.innerHTML = autocompleteResults.map(function (file, index) {
            return '<div class="autocomplete-item' + (index === selectedAutocompleteIndex ? ' selected' : '') + '" data-index="' + index + '">' +
                '<span class="autocomplete-item-icon"><span class="codicon codicon-' + file.icon + '"></span></span>' +
                '<div class="autocomplete-item-content"><span class="autocomplete-item-name">' + escapeHtml(file.name) + '</span>' +
                '<span class="autocomplete-item-path">' + escapeHtml(file.path) + '</span></div></div>';
        }).join('');

        autocompleteList.querySelectorAll('.autocomplete-item').forEach(function (item) {
            item.addEventListener('click', function () { selectAutocompleteItem(parseInt(item.getAttribute('data-index'), 10)); });
            item.addEventListener('mouseenter', function () { selectedAutocompleteIndex = parseInt(item.getAttribute('data-index'), 10); updateAutocompleteSelection(); });
        });
        scrollToSelectedItem();
    }

    function updateAutocompleteSelection() {
        if (!autocompleteList) return;
        autocompleteList.querySelectorAll('.autocomplete-item').forEach(function (item, index) {
            item.classList.toggle('selected', index === selectedAutocompleteIndex);
        });
        scrollToSelectedItem();
    }

    function scrollToSelectedItem() {
        var selectedItem = autocompleteList ? autocompleteList.querySelector('.autocomplete-item.selected') : null;
        if (selectedItem) selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function selectAutocompleteItem(index) {
        if (index < 0 || index >= autocompleteResults.length || !chatInput || autocompleteStartPos < 0) return;
        var file = autocompleteResults[index];
        var value = chatInput.value;
        var cursorPos = chatInput.selectionStart;

        // Check if this is a context item (#terminal, #problems)
        if (file.isContext && file.uri && file.uri.startsWith('context://')) {
            // Remove the #query from input - chip will be added
            chatInput.value = value.substring(0, autocompleteStartPos) + value.substring(cursorPos);
            var newCursorPos = autocompleteStartPos;
            chatInput.setSelectionRange(newCursorPos, newCursorPos);

            // Send context reference request to backend
            vscode.postMessage({
                type: 'selectContextReference',
                contextType: file.name, // 'terminal' or 'problems'
                options: undefined
            });

            hideAutocomplete();
            chatInput.focus();
            autoResizeTextarea();
            updateInputHighlighter();
            saveWebviewState();
            updateSendButtonState();
            return;
        }

        // Regular file/folder reference
        var referenceText = '#' + file.name + ' ';
        chatInput.value = value.substring(0, autocompleteStartPos) + referenceText + value.substring(cursorPos);
        var newCursorPos = autocompleteStartPos + referenceText.length;
        chatInput.setSelectionRange(newCursorPos, newCursorPos);
        vscode.postMessage({ type: 'addFileReference', file: file });
        hideAutocomplete();
        chatInput.focus();
    }

    function syncAttachmentsWithText() {
        var text = chatInput ? chatInput.value : '';
        var toRemove = [];
        currentAttachments.forEach(function (att) {
            // Skip temporary attachments (like pasted images)
            if (att.isTemporary) return;
            // Skip context attachments (#terminal, #problems) - they use context:// URI
            if (att.uri && att.uri.startsWith('context://')) return;
            // Only sync file references that have isTextReference flag
            if (!att.isTextReference) return;
            // Check if the #filename reference still exists in text
            if (text.indexOf('#' + att.name) === -1) toRemove.push(att.id);
        });
        if (toRemove.length > 0) {
            toRemove.forEach(function (id) { vscode.postMessage({ type: 'removeAttachment', attachmentId: id }); });
            currentAttachments = currentAttachments.filter(function (a) { return toRemove.indexOf(a.id) === -1; });
            updateChipsDisplay();
        }
    }

    function handlePaste(event) {
        if (!event.clipboardData) return;
        var items = event.clipboardData.items;
        for (var i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image/') === 0) {
                event.preventDefault();
                var file = items[i].getAsFile();
                if (file) processImageFile(file);
                return;
            }
        }
    }

    function processImageFile(file) {
        var reader = new FileReader();
        reader.onload = function (e) {
            if (e.target && e.target.result) vscode.postMessage({ type: 'saveImage', data: e.target.result, mimeType: file.type });
        };
        reader.readAsDataURL(file);
    }

    function updateChipsDisplay() {
        if (!chipsContainer) return;
        if (currentAttachments.length === 0) {
            chipsContainer.classList.add('hidden');
            chipsContainer.innerHTML = '';
        } else {
            chipsContainer.classList.remove('hidden');
            chipsContainer.innerHTML = currentAttachments.map(function (att) {
                var isImage = att.isTemporary || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.name);
                var iconClass = att.isFolder ? 'folder' : (isImage ? 'file-media' : 'file');
                var displayName = att.isTemporary ? 'Pasted Image' : att.name;
                return '<div class="chip" data-id="' + att.id + '" title="' + escapeHtml(att.uri || att.name) + '">' +
                    '<span class="chip-icon"><span class="codicon codicon-' + iconClass + '"></span></span>' +
                    '<span class="chip-text">' + escapeHtml(displayName) + '</span>' +
                    '<button class="chip-remove" data-remove="' + att.id + '" title="Remove"><span class="codicon codicon-close"></span></button></div>';
            }).join('');

            chipsContainer.querySelectorAll('.chip-remove').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var attId = btn.getAttribute('data-remove');
                    if (attId) removeAttachment(attId);
                });
            });
        }
        // Persist attachments so they survive sidebar tab switches
        saveWebviewState();
    }

    function removeAttachment(attachmentId) {
        vscode.postMessage({ type: 'removeAttachment', attachmentId: attachmentId });
        currentAttachments = currentAttachments.filter(function (a) { return a.id !== attachmentId; });
        updateChipsDisplay();
        // saveWebviewState() is called in updateChipsDisplay
    }

    function escapeHtml(str) {
        if (!str) return '';
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /** Strip markdown syntax for use in plain-text contexts (e.g. card titles). */
    function stripMarkdown(text) {
        if (!text) { return ''; }
        return text
            .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
            .replace(/\*(.+?)\*/g, '$1')         // italic
            .replace(/^#{1,6}\s+/gm, '')          // headings
            .replace(/`(.+?)`/g, '$1')            // inline code
            .replace(/\[(.+?)\]\(.+?\)/g, '$1')  // links
            .trim();
    }

    /** Render only inline markdown (bold, italic, code) — safe for use inside <span> elements. */
    function inlineMarkdown(text) {
        if (!text) { return ''; }
        var html = escapeHtml(text);
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
        html = html.replace(/`(.+?)`/g, '<code>$1</code>');
        return html;
    }

    /** Format ask/reply timestamps for tool call cards.
     *  askedAt: when the question was shown (ms epoch)
     *  answeredAt: when the user replied (ms epoch, = tc.timestamp)
     *  Returns e.g. "14:32 → 14:35" or just "14:32" if no answer yet.
     */
    function formatCallTimestamp(askedAt, answeredAt) {
        var t = askedAt || answeredAt;
        if (!t) { return ''; }
        function fmt(ms) {
            var d = new Date(ms);
            return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
        }
        var asked = fmt(t);
        if (!answeredAt || !askedAt || answeredAt === askedAt) { return asked; }
        return asked + ' → ' + fmt(answeredAt);
    }

    function renderAttachmentsHtml(attachments) {
        if (!attachments || attachments.length === 0) return '';
        var items = attachments.map(function (att) {
            var iconClass = 'file';
            if (att.isFolder) iconClass = 'folder';
            else if (att.name && (att.name.endsWith('.png') || att.name.endsWith('.jpg') || att.name.endsWith('.jpeg'))) iconClass = 'file-media';
            else if ((att.uri || '').indexOf('context://terminal') !== -1) iconClass = 'terminal';
            else if ((att.uri || '').indexOf('context://problems') !== -1) iconClass = 'error';

            return '<div class="chip" style="margin-top:0;" title="' + escapeHtml(att.name) + '">' +
                '<span class="chip-icon"><span class="codicon codicon-' + iconClass + '"></span></span>' +
                '<span class="chip-text">' + escapeHtml(att.name) + '</span>' +
                '</div>';
        }).join('');

        return '<div class="chips-container" style="padding: 6px 0 0 0; border: none;">' + items + '</div>';
    }

    // ══════════════════════════════════════════════════════════
    // ═══  Voice Mode Functions  ═══════════════════════════════
    // ══════════════════════════════════════════════════════════

    var voiceRecording = false; // true while mic is actively recording

    /**
     * Entry point: extension sends voiceStart → show overlay with waveform animation
     * TTS is handled by the extension host (macOS `say` command) — not in the webview.
     */
    async function handleVoiceStart(taskId, question) {
        voiceMode = true;
        voiceTaskId = taskId;
        voiceTranscript = '';
        voiceInterimTranscript = '';
        voiceRecording = false;

        showVoiceOverlay(question);

        // Show speaking animation while extension host speaks via macOS
        updateVoiceStatus('speaking', 'Speaking…');
        startSpeakingAnimation();
        // The extension host will send 'voiceSpeakingDone' when TTS finishes
    }

    /**
     * Extension host finished speaking → show input area for user's response
     */
    function handleVoiceSpeakingDone(taskId) {
        if (!voiceMode || voiceTaskId !== taskId) return;

        stopVoiceAnimation();
        updateVoiceStatus('listening', 'Your turn — speak (Fn+Fn) or type below');

        // Hide skip button, show input area
        var skipBtn = document.getElementById('voice-skip-btn');
        if (skipBtn) skipBtn.classList.add('hidden');

        showVoiceInputArea();

        // Focus the text input immediately
        var textInput = document.getElementById('voice-text-input');
        if (textInput) {
            textInput.focus();
        }
    }

    /**
     * Cleanup: stop everything and hide overlay
     */
    function handleVoiceStop() {
        if (!voiceMode) return;
        cleanupVoiceResources();
        hideVoiceOverlay();
        voiceMode = false;
        voiceTaskId = null;
        voiceRecording = false;
    }

    // ── Voice Overlay UI ──────────────────────────────────────

    function showVoiceOverlay(question) {
        var overlay = document.getElementById('voice-overlay');
        var questionEl = document.getElementById('voice-question');
        var transcriptEl = document.getElementById('voice-transcript');
        var inputArea = document.getElementById('voice-input-area');
        var recordBtn = document.getElementById('voice-record-btn');
        var textInput = document.getElementById('voice-text-input');
        var skipBtn = document.getElementById('voice-skip-btn');

        if (questionEl) questionEl.textContent = question;
        if (transcriptEl) transcriptEl.textContent = '';
        if (inputArea) inputArea.classList.add('hidden');
        if (recordBtn) recordBtn.classList.add('hidden');
        if (textInput) textInput.value = '';
        if (skipBtn) skipBtn.classList.remove('hidden'); // Show skip during speaking
        if (overlay) overlay.classList.remove('hidden');
    }

    function hideVoiceOverlay() {
        var overlay = document.getElementById('voice-overlay');
        if (overlay) overlay.classList.add('hidden');
    }

    function showVoiceInputArea() {
        var inputArea = document.getElementById('voice-input-area');
        var textInput = document.getElementById('voice-text-input');

        // Don't show record button — mic access doesn't work in VS Code webview
        if (inputArea) inputArea.classList.remove('hidden');
        if (textInput) textInput.focus();
    }

    function updateVoiceStatus(phase, text) {
        var statusEl = document.getElementById('voice-status');
        if (!statusEl) return;
        statusEl.textContent = text || phase;
        statusEl.className = 'voice-status voice-status-' + phase;
    }

    function updateTranscriptDisplay() {
        var el = document.getElementById('voice-transcript');
        if (!el) return;
        var full = voiceTranscript + (voiceInterimTranscript ? ' ' + voiceInterimTranscript : '');
        el.textContent = full.trim() || '';
    }

    function sendVoiceResponse(text) {
        if (!voiceTaskId) return;
        vscode.postMessage({
            type: 'voiceResponse',
            taskId: voiceTaskId,
            transcription: text
        });
        handleVoiceStop();
    }

    function sendVoiceError(errorMsg) {
        if (!voiceTaskId) return;
        vscode.postMessage({
            type: 'voiceError',
            taskId: voiceTaskId,
            error: errorMsg
        });
        handleVoiceStop();
    }

    // ── Record Button Logic ───────────────────────────────────

    async function toggleRecording() {
        if (voiceRecording) {
            stopRecording();
        } else {
            await startRecording();
        }
    }

    async function startRecording() {
        var recordBtn = document.getElementById('voice-record-btn');

        // Try SpeechRecognition first (works in some environments)
        var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
            try {
                voiceRecognition = new SpeechRecognition();
                voiceRecognition.continuous = true;
                voiceRecognition.interimResults = true;
                voiceRecognition.lang = 'en-US';

                voiceRecognition.onresult = function(event) {
                    var interim = '';
                    var finalText = '';
                    for (var i = event.resultIndex; i < event.results.length; i++) {
                        var transcript = event.results[i][0].transcript;
                        if (event.results[i].isFinal) {
                            finalText += transcript;
                        } else {
                            interim += transcript;
                        }
                    }
                    if (finalText) {
                        voiceTranscript += (voiceTranscript ? ' ' : '') + finalText.trim();
                    }
                    voiceInterimTranscript = interim;
                    updateTranscriptDisplay();
                    // Also populate the text input with transcript
                    var textInput = document.getElementById('voice-text-input');
                    if (textInput) {
                        textInput.value = (voiceTranscript + ' ' + voiceInterimTranscript).trim();
                    }
                };

                voiceRecognition.onerror = function(event) {
                    console.warn('[Voice] STT error:', event.error);
                    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                        stopRecording();
                        updateVoiceStatus('typing', 'Mic access denied. Type your response or use dictation (Fn Fn)');
                    }
                };

                voiceRecognition.onend = function() {
                    if (voiceRecording) {
                        // Recognition ended but we're still "recording" — try to restart
                        try { voiceRecognition.start(); } catch (e) { stopRecording(); }
                    }
                };

                voiceRecognition.start();
                voiceRecording = true;
                if (recordBtn) recordBtn.classList.add('recording');
                updateVoiceStatus('listening', 'Listening… tap mic to stop');

                // Try to get mic waveform (even if STT handles the transcription separately)
                startMicWaveformAnimation();
                return;
            } catch (e) {
                console.warn('[Voice] SpeechRecognition failed to start:', e);
                voiceRecognition = null;
            }
        }

        // Fallback: try getUserMedia for audio recording + waveform only
        // (no transcription — user sees waveform and types/uses dictation)
        try {
            voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            voiceRecording = true;
            if (recordBtn) recordBtn.classList.add('recording');
            updateVoiceStatus('listening', 'Recording… (no auto-transcription — type what you said below)');
            startMicWaveformAnimation();
        } catch (e) {
            console.warn('[Voice] getUserMedia failed:', e.message);
            updateVoiceStatus('typing', 'Mic not available. Type your response or use dictation (Fn Fn)');
        }
    }

    function stopRecording() {
        voiceRecording = false;
        var recordBtn = document.getElementById('voice-record-btn');
        if (recordBtn) recordBtn.classList.remove('recording');

        if (voiceRecognition) {
            try { voiceRecognition.stop(); } catch (e) { /* ignore */ }
            voiceRecognition = null;
        }

        stopVoiceAnimation();

        if (voiceStream) {
            voiceStream.getTracks().forEach(function(t) { t.stop(); });
            voiceStream = null;
        }
        if (voiceAudioContext) {
            try { voiceAudioContext.close(); } catch (e) { /* ignore */ }
            voiceAudioContext = null;
        }
        voiceAnalyser = null;

        // If we got some transcript, put it in the text input
        var textInput = document.getElementById('voice-text-input');
        if (textInput && voiceTranscript.trim()) {
            textInput.value = voiceTranscript.trim();
        }

        updateVoiceStatus('ready', 'Review and send, or tap mic to record again');
    }

    // ── TTS (Text-to-Speech) ──────────────────────────────────

    function speakText(text) {
        return new Promise(function(resolve) {
            if (!window.speechSynthesis) {
                console.warn('[Voice] SpeechSynthesis not available');
                resolve();
                return;
            }

            // Cancel any ongoing speech
            window.speechSynthesis.cancel();

            var utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = 1.05;
            utterance.pitch = 1.0;
            utterance.volume = 1.0;

            // Try to pick a good voice
            var voices = window.speechSynthesis.getVoices();
            if (voices.length > 0) {
                var preferred = voices.find(function(v) {
                    return v.lang.startsWith('en') && v.name.toLowerCase().includes('natural');
                }) || voices.find(function(v) {
                    return v.lang.startsWith('en') && !v.name.toLowerCase().includes('google');
                }) || voices.find(function(v) {
                    return v.lang.startsWith('en');
                });
                if (preferred) utterance.voice = preferred;
            }

            utterance.onend = function() { resolve(); };
            utterance.onerror = function(e) {
                console.warn('[Voice] TTS error:', e.error);
                resolve();
            };

            window.speechSynthesis.speak(utterance);
        });
    }

    // ── Waveform Animation ────────────────────────────────────

    /**
     * Synthetic "speaking" animation — smooth sine wave bars (no mic needed)
     */
    function startSpeakingAnimation() {
        var canvas = document.getElementById('voice-waveform');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var width = canvas.width;
        var height = canvas.height;
        var phase = 0;

        function draw() {
            if (!voiceMode) return;
            voiceAnimationFrame = requestAnimationFrame(draw);
            ctx.clearRect(0, 0, width, height);

            phase += 0.06;
            var barCount = 32;
            var gap = 3;
            var barWidth = (width - (barCount - 1) * gap) / barCount;
            var centerY = height / 2;

            for (var i = 0; i < barCount; i++) {
                var v1 = Math.sin(phase + i * 0.25) * 0.5 + 0.5;
                var v2 = Math.sin(phase * 1.3 + i * 0.18) * 0.3 + 0.5;
                var v3 = Math.sin(phase * 0.7 + i * 0.35) * 0.2 + 0.5;
                var value = (v1 + v2 + v3) / 3;
                var barHeight = Math.max(3, value * centerY * 0.75);

                var alpha = 0.35 + value * 0.65;
                ctx.fillStyle = 'hsla(210, 85%, 62%, ' + alpha + ')';
                var x = i * (barWidth + gap);
                var radius = barWidth / 2;
                roundedRect(ctx, x, centerY - barHeight, barWidth, barHeight * 2, radius);
            }
        }
        draw();
    }

    /**
     * Real mic-driven waveform animation
     */
    async function startMicWaveformAnimation() {
        var canvas = document.getElementById('voice-waveform');
        if (!canvas) return;

        try {
            // If we already have a stream from recording, reuse it
            if (!voiceStream) {
                voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }
            voiceAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            var source = voiceAudioContext.createMediaStreamSource(voiceStream);
            voiceAnalyser = voiceAudioContext.createAnalyser();
            voiceAnalyser.fftSize = 128;
            voiceAnalyser.smoothingTimeConstant = 0.75;
            source.connect(voiceAnalyser);

            stopVoiceAnimation();

            var ctx = canvas.getContext('2d');
            var width = canvas.width;
            var height = canvas.height;
            var bufferLength = voiceAnalyser.frequencyBinCount;
            var dataArray = new Uint8Array(bufferLength);

            function draw() {
                if (!voiceMode || !voiceAnalyser) return;
                voiceAnimationFrame = requestAnimationFrame(draw);

                voiceAnalyser.getByteFrequencyData(dataArray);
                ctx.clearRect(0, 0, width, height);

                var barCount = 32;
                var gap = 3;
                var barWidth = (width - (barCount - 1) * gap) / barCount;
                var centerY = height / 2;

                for (var i = 0; i < barCount; i++) {
                    var dataIndex = Math.floor(i * bufferLength / barCount);
                    var value = dataArray[dataIndex] / 255;
                    var barHeight = Math.max(3, value * centerY * 0.85);

                    var hue = 210 + value * 40;
                    var alpha = 0.4 + value * 0.6;
                    ctx.fillStyle = 'hsla(' + hue + ', 85%, 60%, ' + alpha + ')';

                    var x = i * (barWidth + gap);
                    var radius = barWidth / 2;
                    roundedRect(ctx, x, centerY - barHeight, barWidth, barHeight * 2, radius);
                }
            }
            draw();
        } catch (err) {
            console.log('[Voice] Mic waveform not available:', err.message);
            // Show a small idle animation instead
            startSpeakingAnimation();
        }
    }

    /**
     * Helper: draw a rounded rectangle (used for waveform bars)
     */
    function roundedRect(ctx, x, y, w, h, r) {
        if (h < 0) { y += h; h = -h; }
        r = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
        ctx.fill();
    }

    function stopVoiceAnimation() {
        if (voiceAnimationFrame) {
            cancelAnimationFrame(voiceAnimationFrame);
            voiceAnimationFrame = null;
        }
    }

    function cleanupVoiceResources() {
        if (voiceRecognition) {
            try { voiceRecognition.abort(); } catch (e) { /* ignore */ }
            voiceRecognition = null;
        }
        stopVoiceAnimation();

        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }

        if (voiceStream) {
            voiceStream.getTracks().forEach(function(t) { t.stop(); });
            voiceStream = null;
        }
        if (voiceAudioContext) {
            try { voiceAudioContext.close(); } catch (e) { /* ignore */ }
            voiceAudioContext = null;
        }
        voiceAnalyser = null;
        voiceTranscript = '';
        voiceInterimTranscript = '';
        voiceRecording = false;

        var canvas = document.getElementById('voice-waveform');
        if (canvas) {
            var ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    /**
     * Wire up voice overlay button events — called from init()
     */
    function initVoiceControls() {
        var sendBtn = document.getElementById('voice-send-btn');
        var cancelBtn = document.getElementById('voice-cancel-btn');
        var recordBtn = document.getElementById('voice-record-btn');
        var micBtn = document.getElementById('mic-btn');
        var textInput = document.getElementById('voice-text-input');
        var skipBtn = document.getElementById('voice-skip-btn');

        if (sendBtn) {
            sendBtn.addEventListener('click', function() {
                var input = document.getElementById('voice-text-input');
                var text = (input && input.value.trim()) || voiceTranscript.trim();
                if (text) {
                    sendVoiceResponse(text);
                }
            });
        }
        if (cancelBtn) {
            cancelBtn.addEventListener('click', function() {
                sendVoiceError('User cancelled voice input');
            });
        }
        if (recordBtn) {
            recordBtn.addEventListener('click', function() {
                toggleRecording();
            });
        }
        if (micBtn) {
            micBtn.addEventListener('click', function() {
                vscode.postMessage({ type: 'micButtonClicked' });
            });
        }
        if (skipBtn) {
            skipBtn.addEventListener('click', function() {
                // Interrupt TTS and skip to input
                vscode.postMessage({ type: 'voiceInterrupt' });
            });
        }
        if (textInput) {
            textInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    var text = textInput.value.trim();
                    if (text) {
                        sendVoiceResponse(text);
                    }
                }
            });
        }
    }

    // ══════════════════════════════════════════════════════════
    // ── Plan Board Functions (sidebar: just Open Board button) ──
    // ══════════════════════════════════════════════════════════

    function updatePlanBoardVisibility() {
        var board = document.getElementById('plan-board');
        if (!board) return;
        board.classList.toggle('hidden', !planEnabled);
    }

    function renderPlanBoard() {
        // No-op in sidebar — board is rendered in editor tab
    }

    function updatePlanTaskStatus(taskId, status, note) {
        // Handled by PlanEditorProvider in editor tab
    }

    function findPlanTaskById(tasks, id) {
        for (var i = 0; i < tasks.length; i++) {
            if (tasks[i].id === id) return tasks[i];
            if (tasks[i].subtasks && tasks[i].subtasks.length > 0) {
                var found = findPlanTaskById(tasks[i].subtasks, id);
                if (found) return found;
            }
        }
        return null;
    }

    function updatePlanExecutionUI() {
        // Handled by PlanEditorProvider in editor tab
    }

    function showPlanAutoAdvanceNotice(fromTaskId, nextTaskId, nextTaskTitle) {
        console.log('[AskAway Plan] Auto-advancing from', fromTaskId, 'to', nextTaskId, ':', nextTaskTitle);
    }

    function editPlanTask(task) {
        // Handled by PlanEditorProvider in editor tab
    }

    function showReviewRejectDialog(task) {
        // Handled by PlanEditorProvider in editor tab
    }

    function showSplitPreview(taskId, subtasks) {
        // Handled by PlanEditorProvider in editor tab
        proposedSplit = null;
    }

    function initPlanBoard() {
        // Wire "Open Board" button to open the editor tab via VS Code command
        var openBoardBtn = document.getElementById('plan-open-board-btn');
        if (openBoardBtn) {
            openBoardBtn.addEventListener('click', function() {
                vscode.postMessage({ type: 'openPlanBoard' });
            });
        }
    }

    // ══════════════════════════════════════════════════════════
    // ── Worker Tabs (Commands + Sub-Agents) ──
    // ══════════════════════════════════════════════════════════

    // Per-panel autopilot state (independent from global autopilotEnabled)
    var workerAutopilotEnabled = { command: false, subagent: false };
    // Per-panel selected model id — set when user picks via native model picker or on models load
    var workerSelectedModelId = { command: '', subagent: '' };
    // Per-panel tool selection: null = all tools, Set<string> = selected subset
    var workerSelectedTools = { command: null, subagent: null };
    // Track which tool groups are expanded
    var workerToolsExpanded = { command: false, subagent: false };
    // Track which tool groups within a panel are expanded: { command: Set<groupName>, subagent: Set<groupName> }
    var workerGroupsExpanded = { command: new Set(), subagent: new Set() };

    function initWorkerTabs() {
        // Tab switching
        var tabs = document.querySelectorAll('.widget-tab');
        tabs.forEach(function(tab) {
            tab.addEventListener('click', function() {
                switchTab(tab.getAttribute('data-tab'));
            });
        });

        ['command', 'subagent'].forEach(function(role) {
            // Run/Autopilot button
            var runBtn = document.getElementById(role + '-autopilot-btn');
            if (runBtn) runBtn.addEventListener('click', function() { workerAutopilot(role); });

            // Submit manual
            var submitBtn = document.getElementById(role + '-submit-btn');
            if (submitBtn) submitBtn.addEventListener('click', function() { workerSubmit(role); });

            // Per-panel autopilot toggle
            var autoToggle = document.getElementById(role + '-autopilot-toggle');
            if (autoToggle) {
                autoToggle.addEventListener('click', function() { toggleWorkerAutopilot(role); });
                autoToggle.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWorkerAutopilot(role); }
                });
            }

            // Model select + effort change → update formed label
            var modelSel = document.getElementById(role + '-model-select');
            if (modelSel) modelSel.addEventListener('change', function() { updateFormedModelLabel(role); });
            var effortSel = document.getElementById(role + '-effort-select');
            if (effortSel) effortSel.addEventListener('change', function() { updateFormedModelLabel(role); });

            // Tools panel header toggle
            var toolsBtn = document.getElementById(role + '-tools-header-btn');
            if (toolsBtn) toolsBtn.addEventListener('click', function() { toggleToolsPanel(role); });
        });

        // Task card click → select it
        document.addEventListener('click', function(e) {
            var card = e.target.closest('.worker-task-card');
            if (!card) return;
            var role = card.getAttribute('data-role');
            var id = card.getAttribute('data-id');
            if (role && id) selectWorkerTask(role, id);
        });

        // Request models from extension
        vscode.postMessage({ type: 'requestModels' });
        updateWorkerManualControlsVisibility('command');
        updateWorkerManualControlsVisibility('subagent');
    }

    function switchTab(tab) {
        currentTab = tab;
        document.querySelectorAll('.widget-tab').forEach(function(btn) {
            btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
        });
        document.querySelectorAll('.tab-panel').forEach(function(panel) {
            panel.classList.toggle('active', panel.id === 'panel-' + tab);
        });
        if (tab === 'subagents') {
            populateModelSelect('subagent-model-select');
            updateFormedModelLabel('subagent');
            if (workerToolsExpanded.subagent) renderToolsPicker('subagent');
        } else if (tab === 'commands') {
            populateModelSelect('command-model-select');
            updateFormedModelLabel('command');
            if (workerToolsExpanded.command) renderToolsPicker('command');
        } else if (tab === 'settings') {
            vscode.postMessage({ type: 'openSettingsModal' });
        } else if (tab === 'observability') {
            updateObservabilityUI();
        }
    }

    function updateTabBadges() {
        var cmdCount = workerTasks.filter(function(t) { return t.role === 'command' && t.status !== 'done'; }).length;
        var agentCount = workerTasks.filter(function(t) { return t.role === 'subagent' && t.status !== 'done'; }).length;

        var cmdBadge = document.getElementById('tab-badge-commands');
        var agentBadge = document.getElementById('tab-badge-subagents');

        if (cmdBadge) {
            cmdBadge.textContent = cmdCount;
            cmdBadge.classList.toggle('hidden', cmdCount === 0);
        }
        if (agentBadge) {
            agentBadge.textContent = agentCount;
            agentBadge.classList.toggle('hidden', agentCount === 0);
        }
    }

    /** Set default model for a role from the first available model (deduplicated by backend) */
    function initWorkerModelDefault(role) {
        if (!workerSelectedModelId[role] && availableModels.length > 0) {
            workerSelectedModelId[role] = availableModels[0].id;
        }
        populateModelSelect(role + '-model-select');
        updateFormedModelLabel(role);
    }

    /** Populate model select with clean deduplicated names */
    function populateModelSelect(selectId) {
        var sel = document.getElementById(selectId);
        if (!sel) return;
        var role = selectId.replace('-model-select', '');
        var prev = workerSelectedModelId[role] || sel.value;
        sel.innerHTML = '';
        if (availableModels.length === 0) {
            sel.innerHTML = '<option value="">No models available</option>';
            return;
        }
        availableModels.forEach(function(m) {
            var opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            sel.appendChild(opt);
        });
        if (prev && Array.from(sel.options).some(function(o) { return o.value === prev; })) {
            sel.value = prev;
            workerSelectedModelId[role] = prev;
        } else if (availableModels.length > 0) {
            sel.value = availableModels[0].id;
            workerSelectedModelId[role] = availableModels[0].id;
        }
        updateFormedModelLabel(role);
    }

    /** Build and display "ModelName · Med" label */
    function updateFormedModelLabel(role) {
        var modelSel = document.getElementById(role + '-model-select');
        var effortSel = document.getElementById(role + '-effort-select');
        var label = document.getElementById(role + '-formed-model');
        if (!label) return;

        var modelName = modelSel && modelSel.selectedOptions[0] ? modelSel.selectedOptions[0].textContent.trim() : '';
        if (modelSel) workerSelectedModelId[role] = modelSel.value;
        var effort = effortSel ? effortSel.value : 'medium';
        var effortDisplay = { low: 'Low ⚡', medium: 'Med', high: 'High 🔥' }[effort] || effort;

        label.textContent = modelName ? modelName + ' · ' + effortDisplay : '—';
    }

    // ── Tool picker ──────────────────────────────────────────

    /** Toggle the tools panel header open/closed */
    function toggleToolsPanel(role) {
        workerToolsExpanded[role] = !workerToolsExpanded[role];
        var body = document.getElementById(role + '-tools-body');
        var chevron = document.getElementById(role + '-tools-chevron');
        var btn = document.getElementById(role + '-tools-header-btn');
        if (body) body.classList.toggle('hidden', !workerToolsExpanded[role]);
        if (btn) btn.setAttribute('aria-expanded', workerToolsExpanded[role] ? 'true' : 'false');
        if (chevron) {
            chevron.classList.toggle('codicon-chevron-right', !workerToolsExpanded[role]);
            chevron.classList.toggle('codicon-chevron-down', workerToolsExpanded[role]);
        }
        if (workerToolsExpanded[role]) renderToolsPicker(role);
    }

    /**
     * Build a picker shape aligned to Copilot's tool picker buckets:
     * - Built-In bucket first
     * - Other buckets derived from tool source tags
     * - Built-In renders direct tool-key rows (agent, browser, edit, execute, ...)
     */
    function groupTools(tools) {
        var builtInToolOrder = ['agent', 'browser', 'edit', 'execute', 'read', 'search', 'todo', 'vscode', 'web', 'memory'];
        var genericTags = new Set(['vscode', 'copilot', 'tool', 'tools', 'built-in', 'builtin', 'mcp', 'internal', 'extension', 'user']);

        function normalizeTags(rawTags) {
            return Array.isArray(rawTags) ? rawTags.map(function(t) { return String(t).toLowerCase(); }) : [];
        }

        function getToolKey(tool) {
            var n = String(tool.name || '').toLowerCase();
            var first = n.split(/[._:/-]/)[0] || n;
            if (builtInToolOrder.indexOf(first) >= 0) return first;
            if (n.indexOf('todo') >= 0) return 'todo';
            if (n.indexOf('browser') >= 0) return 'browser';
            if (n.indexOf('edit') >= 0) return 'edit';
            if (n.indexOf('execute') >= 0 || n.indexOf('terminal') >= 0 || n.indexOf('command') >= 0) return 'execute';
            if (n.indexOf('read') >= 0) return 'read';
            if (n.indexOf('search') >= 0) return 'search';
            if (n.indexOf('agent') >= 0) return 'agent';
            if (n.indexOf('web') >= 0) return 'web';
            if (n.indexOf('vscode') >= 0) return 'vscode';
            return first || 'vscode';
        }

        function inferBucket(tool, tags) {
            var i;

            if (tags.indexOf('built-in') >= 0 || tags.indexOf('builtin') >= 0 || tags.indexOf('internal') >= 0) {
                return { name: 'Built-In', type: 'built-in' };
            }
            if (builtInToolOrder.indexOf(getToolKey(tool)) >= 0) {
                return { name: 'Built-In', type: 'built-in' };
            }

            for (i = 0; i < tags.length; i++) {
                if (tags[i].indexOf('mcp:') === 0) {
                    return { name: tags[i].slice(4) || 'MCP Server', type: 'mcp' };
                }
                if (tags[i].indexOf('server:') === 0) {
                    return { name: tags[i].slice(7) || 'MCP Server', type: 'mcp' };
                }
            }
            if (tags.indexOf('mcp') >= 0) {
                return { name: 'MCP Server', type: 'mcp' };
            }

            for (i = 0; i < tags.length; i++) {
                if (tags[i].indexOf('extension:') === 0) {
                    return { name: tags[i].slice(10) || 'Extension', type: 'extension' };
                }
            }
            if (tags.indexOf('extension') >= 0) {
                return { name: 'Extension', type: 'extension' };
            }

            if (tags.indexOf('user') >= 0 || tags.indexOf('toolset') >= 0) {
                return { name: 'User Defined Tool Sets', type: 'user' };
            }

            for (i = 0; i < tags.length; i++) {
                if (!genericTags.has(tags[i])) {
                    return { name: tags[i], type: 'external' };
                }
            }

            return { name: 'Extension', type: 'extension' };
        }

        var result = {}; // { bucketName: { type, tools, builtInRows } }
        tools.forEach(function(tool) {
            var tags = normalizeTags(tool.tags);
            var bucket = inferBucket(tool, tags);
            if (!result[bucket.name]) {
                result[bucket.name] = {
                    type: bucket.type,
                    tools: [],
                    builtInRows: {}
                };
            }
            result[bucket.name].tools.push(tool);
            if (bucket.type === 'built-in') {
                var key = getToolKey(tool);
                if (!result[bucket.name].builtInRows[key]) result[bucket.name].builtInRows[key] = [];
                result[bucket.name].builtInRows[key].push(tool);
            }
        });

        return result;
    }

    /** Render the grouped per-panel tool picker */
    function renderToolsPicker(role) {
        var body = document.getElementById(role + '-tools-body');
        var headerLabel = document.getElementById(role + '-tools-label');
        if (!body) return;

        var totalTools = availableTools.length;
        var selectedSet = workerSelectedTools[role];
        var selectedCount = selectedSet ? selectedSet.size : totalTools;
        if (headerLabel) {
            headerLabel.textContent = selectedCount + '/' + totalTools + ' tools selected';
        }

        if (totalTools === 0) {
            body.innerHTML = '<div class="worker-tools-empty">No tools registered. Enable MCP servers or VS Code tools first.</div>';
            return;
        }

        var grouped = groupTools(availableTools);
        var html = '<div class="tools-picker">';
        var topGroupNames = Object.keys(grouped).sort(function(a, b) {
            if (a === 'Built-In') return -1;
            if (b === 'Built-In') return 1;
            return a.localeCompare(b);
        });

        topGroupNames.forEach(function(topGroupName) {
            var group = grouped[topGroupName];
            var topTools = group.tools;

            var topAll = topTools.every(function(t) { return !selectedSet || selectedSet.has(t.name); });
            var topSome = !topAll && topTools.some(function(t) { return !selectedSet || selectedSet.has(t.name); });
            var topState = topAll ? 'all' : (topSome ? 'some' : 'none');

            var topKey = topGroupName;
            var topExpanded = workerGroupsExpanded[role].has(topKey);
            var et = escapeHtml(topGroupName);

            html += '<div class="tools-group tools-top-group">';
            html += '<div class="tools-group-header" data-role="' + role + '" data-group="' + escapeHtml(topKey) + '">';
            html += '<span class="tools-group-check ' + topState + '" data-role="' + role + '" data-group="' + escapeHtml(topKey) + '"></span>';
            html += '<span class="tools-group-name">' + et + '</span>';
            html += '<span class="tools-group-count">' + topTools.length + '</span>';
            html += '<span class="codicon ' + (topExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right') + ' tools-group-chevron"></span>';
            html += '</div>';
            html += '<div class="tools-group-items tools-top-items' + (topExpanded ? '' : ' hidden') + '">';

            if (group.type === 'built-in') {
                var order = ['agent', 'browser', 'edit', 'execute', 'read', 'search', 'todo', 'vscode', 'web', 'memory'];
                var rowKeys = Object.keys(group.builtInRows).sort(function(a, b) {
                    var ai = order.indexOf(a);
                    var bi = order.indexOf(b);
                    if (ai === -1 && bi === -1) return a.localeCompare(b);
                    if (ai === -1) return 1;
                    if (bi === -1) return -1;
                    return ai - bi;
                });

                rowKeys.forEach(function(rowKey) {
                    var rowTools = group.builtInRows[rowKey];
                    var rowAll = rowTools.every(function(t) { return !selectedSet || selectedSet.has(t.name); });
                    var rowCount = rowTools.length;

                    html += '<div class="tools-item tools-item-builtinkey">';
                    html += '<input type="checkbox" class="tools-item-check" data-role="' + role + '" data-builtinkey="' + escapeHtml(topGroupName + '::' + rowKey) + '" ' + (rowAll ? 'checked' : '') + '>';
                    html += '<div class="tools-item-info"><span class="tools-item-name">' + escapeHtml(rowKey) + '</span>';
                    if (rowCount > 1) html += '<span class="tools-item-desc">' + rowCount + ' tools</span>';
                    html += '</div></div>';
                });
            } else {
                // Copilot-like shape for non-built-ins: top group -> tools directly.
                topTools.forEach(function(t) {
                    var checked = !selectedSet || selectedSet.has(t.name);
                    html += '<div class="tools-item tools-item-external">';
                    html += '<input type="checkbox" class="tools-item-check" data-role="' + role + '" data-name="' + escapeHtml(t.name) + '" ' + (checked ? 'checked' : '') + '>';
                    html += '<div class="tools-item-info"><span class="tools-item-name">' + escapeHtml(t.name) + '</span>';
                    if (t.description) html += '<span class="tools-item-desc">' + escapeHtml(t.description.slice(0, 90)) + '</span>';
                    html += '</div></div>';
                });
            }

            html += '</div></div>';
        });
        html += '</div>';
        body.innerHTML = html;

        body.querySelectorAll('.tools-group-header').forEach(function(header) {
            header.addEventListener('click', function(e) {
                if (e.target.classList.contains('tools-group-check')) return;
                var r = header.getAttribute('data-role');
                var g = header.getAttribute('data-group');
                if (workerGroupsExpanded[r].has(g)) { workerGroupsExpanded[r].delete(g); } else { workerGroupsExpanded[r].add(g); }
                renderToolsPicker(r);
            });
        });
        body.querySelectorAll('.tools-group-check').forEach(function(span) {
            span.addEventListener('click', function(e) {
                e.stopPropagation();
                var r = span.getAttribute('data-role');
                var g = span.getAttribute('data-group');
                var grouped2 = groupTools(availableTools);
                var gl = [];
                if (grouped2[g]) {
                    gl = grouped2[g].tools.slice();
                }
                if (!workerSelectedTools[r]) workerSelectedTools[r] = new Set(availableTools.map(function(t) { return t.name; }));
                var allSel = gl.every(function(t) { return workerSelectedTools[r].has(t.name); });
                gl.forEach(function(t) { if (allSel) { workerSelectedTools[r].delete(t.name); } else { workerSelectedTools[r].add(t.name); } });
                if (workerSelectedTools[r].size === availableTools.length) workerSelectedTools[r] = null;
                renderToolsPicker(r);
            });
        });
        body.querySelectorAll('.tools-item-check').forEach(function(chk) {
            chk.addEventListener('change', function() {
                var r = chk.getAttribute('data-role');
                var n = chk.getAttribute('data-name');
                var builtInKey = chk.getAttribute('data-builtinkey');
                if (!workerSelectedTools[r]) workerSelectedTools[r] = new Set(availableTools.map(function(t) { return t.name; }));
                if (builtInKey) {
                    var bits = builtInKey.split('::');
                    var top = bits[0];
                    var key = bits.slice(1).join('::');
                    var grouped3 = groupTools(availableTools);
                    var rowTools = (grouped3[top] && grouped3[top].builtInRows && grouped3[top].builtInRows[key]) ? grouped3[top].builtInRows[key] : [];
                    rowTools.forEach(function(t) {
                        if (chk.checked) {
                            workerSelectedTools[r].add(t.name);
                        } else {
                            workerSelectedTools[r].delete(t.name);
                        }
                    });
                } else {
                    if (chk.checked) { workerSelectedTools[r].add(n); } else { workerSelectedTools[r].delete(n); }
                }
                if (workerSelectedTools[r].size === availableTools.length) workerSelectedTools[r] = null;
                renderToolsPicker(r);
            });
        });

        // Native checkboxes support indeterminate state only via property, not markup.
        body.querySelectorAll('.tools-item-check[data-builtinkey]').forEach(function(chk) {
            var r = chk.getAttribute('data-role');
            var builtInKey = chk.getAttribute('data-builtinkey');
            if (!builtInKey) return;
            var bits = builtInKey.split('::');
            var top = bits[0];
            var key = bits.slice(1).join('::');
            var grouped4 = groupTools(availableTools);
            var rowTools = (grouped4[top] && grouped4[top].builtInRows && grouped4[top].builtInRows[key]) ? grouped4[top].builtInRows[key] : [];
            var allSel = rowTools.length > 0 && rowTools.every(function(t) { return !workerSelectedTools[r] || workerSelectedTools[r].has(t.name); });
            var someSel = !allSel && rowTools.some(function(t) { return !workerSelectedTools[r] || workerSelectedTools[r].has(t.name); });
            chk.indeterminate = someSel;
        });
    }

    /** Toggle per-panel autopilot on/off */
    function toggleWorkerAutopilot(role) {
        workerAutopilotEnabled[role] = !workerAutopilotEnabled[role];
        var toggle = document.getElementById(role + '-autopilot-toggle');
        if (toggle) {
            toggle.classList.toggle('active', workerAutopilotEnabled[role]);
            toggle.setAttribute('aria-checked', workerAutopilotEnabled[role] ? 'true' : 'false');
        }
        updateWorkerManualControlsVisibility(role);
        // If turning ON and there's a pending task, run it automatically
        if (workerAutopilotEnabled[role]) {
            var pending = workerTasks.find(function(t) { return t.role === role && t.status === 'pending'; });
            if (pending) {
                selectWorkerTask(role, pending.id);
                workerAutopilot(role);
            }
        }
    }

    /** Hide/show manual input+submit per panel based on autopilot state */
    function updateWorkerManualControlsVisibility(role) {
        var hideManual = workerAutopilotEnabled[role];
        var input = document.getElementById(role + '-response-input');
        var submitBtn = document.getElementById(role + '-submit-btn');
        if (input) input.style.display = hideManual ? 'none' : '';
        if (submitBtn) submitBtn.style.display = hideManual ? 'none' : '';
    }

    /** Run worker task with selected model/effort */
    function workerAutopilot(role) {
        var id = activeWorkerTaskId[role];
        if (!id) {
            var pending = workerTasks.find(function(t) { return t.role === role && t.status === 'pending'; });
            if (pending) { selectWorkerTask(role, pending.id); id = pending.id; }
        }
        if (!id) return;

        var modelSel = document.getElementById(role + '-model-select');
        var modelId = modelSel ? modelSel.value : (workerSelectedModelId[role] || '');
        if (!modelId && availableModels.length > 0) modelId = availableModels[0].id;
        if (!modelId) return;

        var opts = getWorkerRunOptions(role);
        vscode.postMessage({
            type: 'workerRunAutopilot',
            taskId: id,
            modelId: modelId,
            agentName: opts.agentName,
            thinkingEffort: opts.thinkingEffort
        });
    }

    function getWorkerRunOptions(role) {
        var agentSel = document.getElementById(role + '-agent-select');
        var effortSel = document.getElementById(role + '-effort-select');
        return {
            agentName: agentSel ? agentSel.value : 'default',
            thinkingEffort: effortSel ? effortSel.value : 'medium'
        };
    }

    // ── Tool count display (config opens native VS Code dialog) ──────────────────────────────────────────

    function updateToolsCount(role) {
        // kept for any legacy call sites — no-op now that count is in renderToolsPicker header
    }

    // groupTools is defined above with two-level hierarchy; keep single source of truth.

    // ── Queue / task rendering ───────────────────────────────

    function renderWorkerQueue(role) {
        var listId = role === 'command' ? 'command-task-list' : 'subagent-task-list';
        var list = document.getElementById(listId);
        if (!list) return;

        var tasks = workerTasks.filter(function(t) { return t.role === role; });
        if (tasks.length === 0) {
            list.innerHTML = '<div class="worker-empty">No pending ' + (role === 'command' ? 'commands' : 'agent tasks') + '</div>';
            return;
        }

        list.innerHTML = tasks.map(function(t) {
            var summary = t.task.length > 120 ? t.task.slice(0, 120) + '…' : t.task;
            var isActive = activeWorkerTaskId[role] === t.id;
            var statusLabel = t.status === 'running' ? 'Running…' : t.status === 'done' ? '✓ Done' : 'Pending';
            return '<div class="worker-task-card' + (isActive ? ' active-task' : '') + '" data-id="' + t.id + '" data-role="' + role + '">' +
                '<div class="worker-task-card-header">' +
                '<span class="worker-task-role">' + (role === 'command' ? 'CMD' : 'AGENT') + '</span>' +
                '<span class="worker-task-status ' + t.status + '">' + statusLabel + '</span>' +
                '</div>' +
                '<div class="worker-task-summary">' + escapeHtml(summary) + '</div>' +
                '</div>';
        }).join('');
    }

    function selectWorkerTask(role, id) {
        activeWorkerTaskId[role] = id;
        var task = workerTasks.find(function(t) { return t.id === id; });
        if (!task) return;

        var displayId = role === 'command' ? 'command-task-display' : 'subagent-task-display';
        var textId = role === 'command' ? 'command-task-text' : 'subagent-task-text';
        var display = document.getElementById(displayId);
        var textEl = document.getElementById(textId);

        if (display) display.classList.remove('hidden');
        if (textEl) textEl.textContent = task.task;

        renderWorkerQueue(role);
    }

    function workerSubmit(role) {
        var id = activeWorkerTaskId[role];
        if (!id) {
            var pending = workerTasks.find(function(t) { return t.role === role && t.status === 'pending'; });
            if (pending) { selectWorkerTask(role, pending.id); id = pending.id; }
        }
        if (!id) return;

        var inputId = role === 'command' ? 'command-response-input' : 'subagent-response-input';
        var input = document.getElementById(inputId);
        var result = input ? input.value.trim() : '';
        if (!result) return;

        vscode.postMessage({ type: 'workerResolveManual', taskId: id, result: result });
        if (input) input.value = '';
        activeWorkerTaskId[role] = null;

        var displayId = role === 'command' ? 'command-task-display' : 'subagent-task-display';
        var display = document.getElementById(displayId);
        if (display) display.classList.add('hidden');
    }

    function handleWorkerQueueUpdate(tasks) {
        workerTasks = tasks || [];
        renderWorkerQueue('command');
        renderWorkerQueue('subagent');
        updateTabBadges();
        updateObservabilityUI();

        ['command', 'subagent'].forEach(function(role) {
            if (!activeWorkerTaskId[role]) {
                var pending = workerTasks.find(function(t) { return t.role === role && t.status === 'pending'; });
                if (pending) selectWorkerTask(role, pending.id);
            }
            // If autopilot is on and a new pending task arrives, run it
            if (workerAutopilotEnabled[role]) {
                var pending = workerTasks.find(function(t) { return t.role === role && t.status === 'pending'; });
                if (pending) {
                    selectWorkerTask(role, pending.id);
                    workerAutopilot(role);
                }
            }
        });
    }

    // ══════════════════════════════════════════════════════════

    // Expose message handler for remote server (Socket.io bridge)
    window.dispatchVSCodeMessage = function(message) {
        handleExtensionMessage({ data: message });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}());
