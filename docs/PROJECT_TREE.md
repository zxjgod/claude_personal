# 项目目录结构

> 解析自 `cc-recovered-main`，按真实目录层级列出。目录即模块，其下缩进项为该模块包含的子模块与具体代码文件。

> 共 307 个目录、1912 个文件。

```text
cc-recovered-main
├── scripts
│   └── build.mjs
├── src
│   ├── assistant
│   │   └── sessionHistory.ts
│   ├── bootstrap
│   │   └── state.ts
│   ├── bridge
│   │   ├── bridgeApi.ts
│   │   ├── bridgeConfig.ts
│   │   ├── bridgeDebug.ts
│   │   ├── bridgeEnabled.ts
│   │   ├── bridgeMain.ts
│   │   ├── bridgeMessaging.ts
│   │   ├── bridgePermissionCallbacks.ts
│   │   ├── bridgePointer.ts
│   │   ├── bridgeStatusUtil.ts
│   │   ├── bridgeUI.ts
│   │   ├── capacityWake.ts
│   │   ├── codeSessionApi.ts
│   │   ├── createSession.ts
│   │   ├── debugUtils.ts
│   │   ├── envLessBridgeConfig.ts
│   │   ├── flushGate.ts
│   │   ├── inboundAttachments.ts
│   │   ├── inboundMessages.ts
│   │   ├── initReplBridge.ts
│   │   ├── jwtUtils.ts
│   │   ├── pollConfig.ts
│   │   ├── pollConfigDefaults.ts
│   │   ├── remoteBridgeCore.ts
│   │   ├── replBridge.ts
│   │   ├── replBridgeHandle.ts
│   │   ├── replBridgeTransport.ts
│   │   ├── sessionIdCompat.ts
│   │   ├── sessionRunner.ts
│   │   ├── trustedDevice.ts
│   │   ├── types.ts
│   │   └── workSecret.ts
│   ├── buddy
│   │   ├── companion.ts
│   │   ├── CompanionSprite.tsx
│   │   ├── prompt.ts
│   │   ├── sprites.ts
│   │   ├── types.ts
│   │   └── useBuddyNotification.tsx
│   ├── cli
│   │   ├── handlers
│   │   │   ├── agents.ts
│   │   │   ├── auth.ts
│   │   │   ├── autoMode.ts
│   │   │   ├── mcp.tsx
│   │   │   ├── plugins.ts
│   │   │   └── util.tsx
│   │   ├── transports
│   │   │   ├── ccrClient.ts
│   │   │   ├── HybridTransport.ts
│   │   │   ├── SerialBatchEventUploader.ts
│   │   │   ├── SSETransport.ts
│   │   │   ├── transportUtils.ts
│   │   │   ├── WebSocketTransport.ts
│   │   │   └── WorkerStateUploader.ts
│   │   ├── exit.ts
│   │   ├── ndjsonSafeStringify.ts
│   │   ├── print.ts
│   │   ├── remoteIO.ts
│   │   ├── structuredIO.ts
│   │   └── update.ts
│   ├── commands
│   │   ├── add-dir
│   │   │   ├── add-dir.tsx
│   │   │   ├── index.ts
│   │   │   └── validation.ts
│   │   ├── agents
│   │   │   ├── agents.tsx
│   │   │   └── index.ts
│   │   ├── ant-trace
│   │   │   └── index.js
│   │   ├── autofix-pr
│   │   │   └── index.js
│   │   ├── backfill-sessions
│   │   │   └── index.js
│   │   ├── branch
│   │   │   ├── branch.ts
│   │   │   └── index.ts
│   │   ├── break-cache
│   │   │   └── index.js
│   │   ├── bridge
│   │   │   ├── bridge.tsx
│   │   │   └── index.ts
│   │   ├── btw
│   │   │   ├── btw.tsx
│   │   │   └── index.ts
│   │   ├── bughunter
│   │   │   └── index.js
│   │   ├── chrome
│   │   │   ├── chrome.tsx
│   │   │   └── index.ts
│   │   ├── clear
│   │   │   ├── caches.ts
│   │   │   ├── clear.ts
│   │   │   ├── conversation.ts
│   │   │   └── index.ts
│   │   ├── color
│   │   │   ├── color.ts
│   │   │   └── index.ts
│   │   ├── compact
│   │   │   ├── compact.ts
│   │   │   └── index.ts
│   │   ├── config
│   │   │   ├── config.tsx
│   │   │   └── index.ts
│   │   ├── context
│   │   │   ├── context-noninteractive.ts
│   │   │   ├── context.tsx
│   │   │   └── index.ts
│   │   ├── copy
│   │   │   ├── copy.tsx
│   │   │   └── index.ts
│   │   ├── cost
│   │   │   ├── cost.ts
│   │   │   └── index.ts
│   │   ├── ctx_viz
│   │   │   └── index.js
│   │   ├── debug-tool-call
│   │   │   └── index.js
│   │   ├── desktop
│   │   │   ├── desktop.tsx
│   │   │   └── index.ts
│   │   ├── diff
│   │   │   ├── diff.tsx
│   │   │   └── index.ts
│   │   ├── doctor
│   │   │   ├── doctor.tsx
│   │   │   └── index.ts
│   │   ├── effort
│   │   │   ├── effort.tsx
│   │   │   └── index.ts
│   │   ├── env
│   │   │   └── index.js
│   │   ├── exit
│   │   │   ├── exit.tsx
│   │   │   └── index.ts
│   │   ├── export
│   │   │   ├── export.tsx
│   │   │   └── index.ts
│   │   ├── extra-usage
│   │   │   ├── extra-usage-core.ts
│   │   │   ├── extra-usage-noninteractive.ts
│   │   │   ├── extra-usage.tsx
│   │   │   └── index.ts
│   │   ├── fast
│   │   │   ├── fast.tsx
│   │   │   └── index.ts
│   │   ├── feedback
│   │   │   ├── feedback.tsx
│   │   │   └── index.ts
│   │   ├── files
│   │   │   ├── files.ts
│   │   │   └── index.ts
│   │   ├── good-claude
│   │   │   └── index.js
│   │   ├── heapdump
│   │   │   ├── heapdump.ts
│   │   │   └── index.ts
│   │   ├── help
│   │   │   ├── help.tsx
│   │   │   └── index.ts
│   │   ├── hooks
│   │   │   ├── hooks.tsx
│   │   │   └── index.ts
│   │   ├── ide
│   │   │   ├── ide.tsx
│   │   │   └── index.ts
│   │   ├── install-github-app
│   │   │   ├── ApiKeyStep.tsx
│   │   │   ├── CheckExistingSecretStep.tsx
│   │   │   ├── CheckGitHubStep.tsx
│   │   │   ├── ChooseRepoStep.tsx
│   │   │   ├── CreatingStep.tsx
│   │   │   ├── ErrorStep.tsx
│   │   │   ├── ExistingWorkflowStep.tsx
│   │   │   ├── index.ts
│   │   │   ├── install-github-app.tsx
│   │   │   ├── InstallAppStep.tsx
│   │   │   ├── OAuthFlowStep.tsx
│   │   │   ├── setupGitHubActions.ts
│   │   │   ├── SuccessStep.tsx
│   │   │   └── WarningsStep.tsx
│   │   ├── install-slack-app
│   │   │   ├── index.ts
│   │   │   └── install-slack-app.ts
│   │   ├── issue
│   │   │   └── index.js
│   │   ├── keybindings
│   │   │   ├── index.ts
│   │   │   └── keybindings.ts
│   │   ├── login
│   │   │   ├── index.ts
│   │   │   └── login.tsx
│   │   ├── logout
│   │   │   ├── index.ts
│   │   │   └── logout.tsx
│   │   ├── mcp
│   │   │   ├── addCommand.ts
│   │   │   ├── index.ts
│   │   │   ├── mcp.tsx
│   │   │   └── xaaIdpCommand.ts
│   │   ├── memory
│   │   │   ├── index.ts
│   │   │   └── memory.tsx
│   │   ├── mobile
│   │   │   ├── index.ts
│   │   │   └── mobile.tsx
│   │   ├── mock-limits
│   │   │   └── index.js
│   │   ├── model
│   │   │   ├── index.ts
│   │   │   └── model.tsx
│   │   ├── oauth-refresh
│   │   │   └── index.js
│   │   ├── onboarding
│   │   │   └── index.js
│   │   ├── output-style
│   │   │   ├── index.ts
│   │   │   └── output-style.tsx
│   │   ├── passes
│   │   │   ├── index.ts
│   │   │   └── passes.tsx
│   │   ├── perf-issue
│   │   │   └── index.js
│   │   ├── permissions
│   │   │   ├── index.ts
│   │   │   └── permissions.tsx
│   │   ├── plan
│   │   │   ├── index.ts
│   │   │   └── plan.tsx
│   │   ├── plugin
│   │   │   ├── AddMarketplace.tsx
│   │   │   ├── BrowseMarketplace.tsx
│   │   │   ├── DiscoverPlugins.tsx
│   │   │   ├── index.tsx
│   │   │   ├── ManageMarketplaces.tsx
│   │   │   ├── ManagePlugins.tsx
│   │   │   ├── parseArgs.ts
│   │   │   ├── plugin.tsx
│   │   │   ├── pluginDetailsHelpers.tsx
│   │   │   ├── PluginErrors.tsx
│   │   │   ├── PluginOptionsDialog.tsx
│   │   │   ├── PluginOptionsFlow.tsx
│   │   │   ├── PluginSettings.tsx
│   │   │   ├── PluginTrustWarning.tsx
│   │   │   ├── UnifiedInstalledCell.tsx
│   │   │   ├── usePagination.ts
│   │   │   └── ValidatePlugin.tsx
│   │   ├── pr_comments
│   │   │   └── index.ts
│   │   ├── privacy-settings
│   │   │   ├── index.ts
│   │   │   └── privacy-settings.tsx
│   │   ├── rate-limit-options
│   │   │   ├── index.ts
│   │   │   └── rate-limit-options.tsx
│   │   ├── release-notes
│   │   │   ├── index.ts
│   │   │   └── release-notes.ts
│   │   ├── reload-plugins
│   │   │   ├── index.ts
│   │   │   └── reload-plugins.ts
│   │   ├── remote-env
│   │   │   ├── index.ts
│   │   │   └── remote-env.tsx
│   │   ├── remote-setup
│   │   │   ├── api.ts
│   │   │   ├── index.ts
│   │   │   └── remote-setup.tsx
│   │   ├── rename
│   │   │   ├── generateSessionName.ts
│   │   │   ├── index.ts
│   │   │   └── rename.ts
│   │   ├── reset-limits
│   │   │   └── index.js
│   │   ├── resume
│   │   │   ├── index.ts
│   │   │   └── resume.tsx
│   │   ├── review
│   │   │   ├── reviewRemote.ts
│   │   │   ├── ultrareviewCommand.tsx
│   │   │   ├── ultrareviewEnabled.ts
│   │   │   └── UltrareviewOverageDialog.tsx
│   │   ├── rewind
│   │   │   ├── index.ts
│   │   │   └── rewind.ts
│   │   ├── sandbox-toggle
│   │   │   ├── index.ts
│   │   │   └── sandbox-toggle.tsx
│   │   ├── session
│   │   │   ├── index.ts
│   │   │   └── session.tsx
│   │   ├── share
│   │   │   └── index.js
│   │   ├── skills
│   │   │   ├── index.ts
│   │   │   └── skills.tsx
│   │   ├── stats
│   │   │   ├── index.ts
│   │   │   └── stats.tsx
│   │   ├── status
│   │   │   ├── index.ts
│   │   │   └── status.tsx
│   │   ├── stickers
│   │   │   ├── index.ts
│   │   │   └── stickers.ts
│   │   ├── summary
│   │   │   └── index.js
│   │   ├── tag
│   │   │   ├── index.ts
│   │   │   └── tag.tsx
│   │   ├── tasks
│   │   │   ├── index.ts
│   │   │   └── tasks.tsx
│   │   ├── teleport
│   │   │   └── index.js
│   │   ├── terminalSetup
│   │   │   ├── index.ts
│   │   │   └── terminalSetup.tsx
│   │   ├── theme
│   │   │   ├── index.ts
│   │   │   └── theme.tsx
│   │   ├── thinkback
│   │   │   ├── index.ts
│   │   │   └── thinkback.tsx
│   │   ├── thinkback-play
│   │   │   ├── index.ts
│   │   │   └── thinkback-play.ts
│   │   ├── upgrade
│   │   │   ├── index.ts
│   │   │   └── upgrade.tsx
│   │   ├── usage
│   │   │   ├── index.ts
│   │   │   └── usage.tsx
│   │   ├── vim
│   │   │   ├── index.ts
│   │   │   └── vim.ts
│   │   ├── voice
│   │   │   ├── index.ts
│   │   │   └── voice.ts
│   │   ├── advisor.ts
│   │   ├── bridge-kick.ts
│   │   ├── brief.ts
│   │   ├── commit-push-pr.ts
│   │   ├── commit.ts
│   │   ├── createMovedToPluginCommand.ts
│   │   ├── init-verifiers.ts
│   │   ├── init.ts
│   │   ├── insights.ts
│   │   ├── install.tsx
│   │   ├── review.ts
│   │   ├── security-review.ts
│   │   ├── statusline.tsx
│   │   ├── ultraplan.tsx
│   │   └── version.ts
│   ├── components
│   │   ├── agents
│   │   │   ├── new-agent-creation
│   │   │   │   ├── wizard-steps
│   │   │   │   │   ├── ColorStep.tsx
│   │   │   │   │   ├── ConfirmStep.tsx
│   │   │   │   │   ├── ConfirmStepWrapper.tsx
│   │   │   │   │   ├── DescriptionStep.tsx
│   │   │   │   │   ├── GenerateStep.tsx
│   │   │   │   │   ├── LocationStep.tsx
│   │   │   │   │   ├── MemoryStep.tsx
│   │   │   │   │   ├── MethodStep.tsx
│   │   │   │   │   ├── ModelStep.tsx
│   │   │   │   │   ├── PromptStep.tsx
│   │   │   │   │   ├── ToolsStep.tsx
│   │   │   │   │   └── TypeStep.tsx
│   │   │   │   └── CreateAgentWizard.tsx
│   │   │   ├── AgentDetail.tsx
│   │   │   ├── AgentEditor.tsx
│   │   │   ├── agentFileUtils.ts
│   │   │   ├── AgentNavigationFooter.tsx
│   │   │   ├── AgentsList.tsx
│   │   │   ├── AgentsMenu.tsx
│   │   │   ├── ColorPicker.tsx
│   │   │   ├── generateAgent.ts
│   │   │   ├── ModelSelector.tsx
│   │   │   ├── ToolSelector.tsx
│   │   │   ├── types.ts
│   │   │   ├── utils.ts
│   │   │   └── validateAgent.ts
│   │   ├── ClaudeCodeHint
│   │   │   └── PluginHintMenu.tsx
│   │   ├── CustomSelect
│   │   │   ├── index.ts
│   │   │   ├── option-map.ts
│   │   │   ├── select-input-option.tsx
│   │   │   ├── select-option.tsx
│   │   │   ├── select.tsx
│   │   │   ├── SelectMulti.tsx
│   │   │   ├── use-multi-select-state.ts
│   │   │   ├── use-select-input.ts
│   │   │   ├── use-select-navigation.ts
│   │   │   └── use-select-state.ts
│   │   ├── design-system
│   │   │   ├── Byline.tsx
│   │   │   ├── color.ts
│   │   │   ├── Dialog.tsx
│   │   │   ├── Divider.tsx
│   │   │   ├── FuzzyPicker.tsx
│   │   │   ├── KeyboardShortcutHint.tsx
│   │   │   ├── ListItem.tsx
│   │   │   ├── LoadingState.tsx
│   │   │   ├── Pane.tsx
│   │   │   ├── ProgressBar.tsx
│   │   │   ├── Ratchet.tsx
│   │   │   ├── StatusIcon.tsx
│   │   │   ├── Tabs.tsx
│   │   │   ├── ThemedBox.tsx
│   │   │   ├── ThemedText.tsx
│   │   │   └── ThemeProvider.tsx
│   │   ├── DesktopUpsell
│   │   │   └── DesktopUpsellStartup.tsx
│   │   ├── diff
│   │   │   ├── DiffDetailView.tsx
│   │   │   ├── DiffDialog.tsx
│   │   │   └── DiffFileList.tsx
│   │   ├── FeedbackSurvey
│   │   │   ├── FeedbackSurvey.tsx
│   │   │   ├── FeedbackSurveyView.tsx
│   │   │   ├── submitTranscriptShare.ts
│   │   │   ├── TranscriptSharePrompt.tsx
│   │   │   ├── useDebouncedDigitInput.ts
│   │   │   ├── useFeedbackSurvey.tsx
│   │   │   ├── useMemorySurvey.tsx
│   │   │   ├── usePostCompactSurvey.tsx
│   │   │   └── useSurveyState.tsx
│   │   ├── grove
│   │   │   └── Grove.tsx
│   │   ├── HelpV2
│   │   │   ├── Commands.tsx
│   │   │   ├── General.tsx
│   │   │   └── HelpV2.tsx
│   │   ├── HighlightedCode
│   │   │   └── Fallback.tsx
│   │   ├── hooks
│   │   │   ├── HooksConfigMenu.tsx
│   │   │   ├── PromptDialog.tsx
│   │   │   ├── SelectEventMode.tsx
│   │   │   ├── SelectHookMode.tsx
│   │   │   ├── SelectMatcherMode.tsx
│   │   │   └── ViewHookMode.tsx
│   │   ├── LogoV2
│   │   │   ├── AnimatedAsterisk.tsx
│   │   │   ├── AnimatedClawd.tsx
│   │   │   ├── ChannelsNotice.tsx
│   │   │   ├── Clawd.tsx
│   │   │   ├── CondensedLogo.tsx
│   │   │   ├── EmergencyTip.tsx
│   │   │   ├── Feed.tsx
│   │   │   ├── FeedColumn.tsx
│   │   │   ├── feedConfigs.tsx
│   │   │   ├── GuestPassesUpsell.tsx
│   │   │   ├── LogoV2.tsx
│   │   │   ├── Opus1mMergeNotice.tsx
│   │   │   ├── OverageCreditUpsell.tsx
│   │   │   ├── VoiceModeNotice.tsx
│   │   │   └── WelcomeV2.tsx
│   │   ├── LspRecommendation
│   │   │   └── LspRecommendationMenu.tsx
│   │   ├── ManagedSettingsSecurityDialog
│   │   │   ├── ManagedSettingsSecurityDialog.tsx
│   │   │   └── utils.ts
│   │   ├── mcp
│   │   │   ├── utils
│   │   │   │   └── reconnectHelpers.tsx
│   │   │   ├── CapabilitiesSection.tsx
│   │   │   ├── ElicitationDialog.tsx
│   │   │   ├── index.ts
│   │   │   ├── MCPAgentServerMenu.tsx
│   │   │   ├── MCPListPanel.tsx
│   │   │   ├── McpParsingWarnings.tsx
│   │   │   ├── MCPReconnect.tsx
│   │   │   ├── MCPRemoteServerMenu.tsx
│   │   │   ├── MCPSettings.tsx
│   │   │   ├── MCPStdioServerMenu.tsx
│   │   │   ├── MCPToolDetailView.tsx
│   │   │   └── MCPToolListView.tsx
│   │   ├── memory
│   │   │   ├── MemoryFileSelector.tsx
│   │   │   └── MemoryUpdateNotification.tsx
│   │   ├── messages
│   │   │   ├── UserToolResultMessage
│   │   │   │   ├── RejectedPlanMessage.tsx
│   │   │   │   ├── RejectedToolUseMessage.tsx
│   │   │   │   ├── UserToolCanceledMessage.tsx
│   │   │   │   ├── UserToolErrorMessage.tsx
│   │   │   │   ├── UserToolRejectMessage.tsx
│   │   │   │   ├── UserToolResultMessage.tsx
│   │   │   │   ├── UserToolSuccessMessage.tsx
│   │   │   │   └── utils.tsx
│   │   │   ├── AdvisorMessage.tsx
│   │   │   ├── AssistantRedactedThinkingMessage.tsx
│   │   │   ├── AssistantTextMessage.tsx
│   │   │   ├── AssistantThinkingMessage.tsx
│   │   │   ├── AssistantToolUseMessage.tsx
│   │   │   ├── AttachmentMessage.tsx
│   │   │   ├── CollapsedReadSearchContent.tsx
│   │   │   ├── CompactBoundaryMessage.tsx
│   │   │   ├── GroupedToolUseContent.tsx
│   │   │   ├── HighlightedThinkingText.tsx
│   │   │   ├── HookProgressMessage.tsx
│   │   │   ├── nullRenderingAttachments.ts
│   │   │   ├── PlanApprovalMessage.tsx
│   │   │   ├── RateLimitMessage.tsx
│   │   │   ├── ShutdownMessage.tsx
│   │   │   ├── SystemAPIErrorMessage.tsx
│   │   │   ├── SystemTextMessage.tsx
│   │   │   ├── TaskAssignmentMessage.tsx
│   │   │   ├── teamMemCollapsed.tsx
│   │   │   ├── teamMemSaved.ts
│   │   │   ├── UserAgentNotificationMessage.tsx
│   │   │   ├── UserBashInputMessage.tsx
│   │   │   ├── UserBashOutputMessage.tsx
│   │   │   ├── UserChannelMessage.tsx
│   │   │   ├── UserCommandMessage.tsx
│   │   │   ├── UserImageMessage.tsx
│   │   │   ├── UserLocalCommandOutputMessage.tsx
│   │   │   ├── UserMemoryInputMessage.tsx
│   │   │   ├── UserPlanMessage.tsx
│   │   │   ├── UserPromptMessage.tsx
│   │   │   ├── UserResourceUpdateMessage.tsx
│   │   │   ├── UserTeammateMessage.tsx
│   │   │   └── UserTextMessage.tsx
│   │   ├── Passes
│   │   │   └── Passes.tsx
│   │   ├── permissions
│   │   │   ├── AskUserQuestionPermissionRequest
│   │   │   │   ├── AskUserQuestionPermissionRequest.tsx
│   │   │   │   ├── PreviewBox.tsx
│   │   │   │   ├── PreviewQuestionView.tsx
│   │   │   │   ├── QuestionNavigationBar.tsx
│   │   │   │   ├── QuestionView.tsx
│   │   │   │   ├── SubmitQuestionsView.tsx
│   │   │   │   └── use-multiple-choice-state.ts
│   │   │   ├── BashPermissionRequest
│   │   │   │   ├── BashPermissionRequest.tsx
│   │   │   │   └── bashToolUseOptions.tsx
│   │   │   ├── ComputerUseApproval
│   │   │   │   └── ComputerUseApproval.tsx
│   │   │   ├── EnterPlanModePermissionRequest
│   │   │   │   └── EnterPlanModePermissionRequest.tsx
│   │   │   ├── ExitPlanModePermissionRequest
│   │   │   │   └── ExitPlanModePermissionRequest.tsx
│   │   │   ├── FileEditPermissionRequest
│   │   │   │   └── FileEditPermissionRequest.tsx
│   │   │   ├── FilePermissionDialog
│   │   │   │   ├── FilePermissionDialog.tsx
│   │   │   │   ├── ideDiffConfig.ts
│   │   │   │   ├── permissionOptions.tsx
│   │   │   │   ├── useFilePermissionDialog.ts
│   │   │   │   └── usePermissionHandler.ts
│   │   │   ├── FilesystemPermissionRequest
│   │   │   │   └── FilesystemPermissionRequest.tsx
│   │   │   ├── FileWritePermissionRequest
│   │   │   │   ├── FileWritePermissionRequest.tsx
│   │   │   │   └── FileWriteToolDiff.tsx
│   │   │   ├── NotebookEditPermissionRequest
│   │   │   │   ├── NotebookEditPermissionRequest.tsx
│   │   │   │   └── NotebookEditToolDiff.tsx
│   │   │   ├── PowerShellPermissionRequest
│   │   │   │   ├── PowerShellPermissionRequest.tsx
│   │   │   │   └── powershellToolUseOptions.tsx
│   │   │   ├── rules
│   │   │   │   ├── AddPermissionRules.tsx
│   │   │   │   ├── AddWorkspaceDirectory.tsx
│   │   │   │   ├── PermissionRuleDescription.tsx
│   │   │   │   ├── PermissionRuleInput.tsx
│   │   │   │   ├── PermissionRuleList.tsx
│   │   │   │   ├── RecentDenialsTab.tsx
│   │   │   │   ├── RemoveWorkspaceDirectory.tsx
│   │   │   │   └── WorkspaceTab.tsx
│   │   │   ├── SedEditPermissionRequest
│   │   │   │   └── SedEditPermissionRequest.tsx
│   │   │   ├── SkillPermissionRequest
│   │   │   │   └── SkillPermissionRequest.tsx
│   │   │   ├── WebFetchPermissionRequest
│   │   │   │   └── WebFetchPermissionRequest.tsx
│   │   │   ├── FallbackPermissionRequest.tsx
│   │   │   ├── hooks.ts
│   │   │   ├── PermissionDecisionDebugInfo.tsx
│   │   │   ├── PermissionDialog.tsx
│   │   │   ├── PermissionExplanation.tsx
│   │   │   ├── PermissionPrompt.tsx
│   │   │   ├── PermissionRequest.tsx
│   │   │   ├── PermissionRequestTitle.tsx
│   │   │   ├── PermissionRuleExplanation.tsx
│   │   │   ├── SandboxPermissionRequest.tsx
│   │   │   ├── shellPermissionHelpers.tsx
│   │   │   ├── useShellPermissionFeedback.ts
│   │   │   ├── utils.ts
│   │   │   ├── WorkerBadge.tsx
│   │   │   └── WorkerPendingPermission.tsx
│   │   ├── PromptInput
│   │   │   ├── HistorySearchInput.tsx
│   │   │   ├── inputModes.ts
│   │   │   ├── inputPaste.ts
│   │   │   ├── IssueFlagBanner.tsx
│   │   │   ├── Notifications.tsx
│   │   │   ├── PromptInput.tsx
│   │   │   ├── PromptInputFooter.tsx
│   │   │   ├── PromptInputFooterLeftSide.tsx
│   │   │   ├── PromptInputFooterSuggestions.tsx
│   │   │   ├── PromptInputHelpMenu.tsx
│   │   │   ├── PromptInputModeIndicator.tsx
│   │   │   ├── PromptInputQueuedCommands.tsx
│   │   │   ├── PromptInputStashNotice.tsx
│   │   │   ├── SandboxPromptFooterHint.tsx
│   │   │   ├── ShimmeredInput.tsx
│   │   │   ├── useMaybeTruncateInput.ts
│   │   │   ├── usePromptInputPlaceholder.ts
│   │   │   ├── useShowFastIconHint.ts
│   │   │   ├── useSwarmBanner.ts
│   │   │   ├── utils.ts
│   │   │   └── VoiceIndicator.tsx
│   │   ├── sandbox
│   │   │   ├── SandboxConfigTab.tsx
│   │   │   ├── SandboxDependenciesTab.tsx
│   │   │   ├── SandboxDoctorSection.tsx
│   │   │   ├── SandboxOverridesTab.tsx
│   │   │   └── SandboxSettings.tsx
│   │   ├── Settings
│   │   │   ├── Config.tsx
│   │   │   ├── Settings.tsx
│   │   │   ├── Status.tsx
│   │   │   └── Usage.tsx
│   │   ├── shell
│   │   │   ├── ExpandShellOutputContext.tsx
│   │   │   ├── OutputLine.tsx
│   │   │   ├── ShellProgressMessage.tsx
│   │   │   └── ShellTimeDisplay.tsx
│   │   ├── skills
│   │   │   └── SkillsMenu.tsx
│   │   ├── Spinner
│   │   │   ├── FlashingChar.tsx
│   │   │   ├── GlimmerMessage.tsx
│   │   │   ├── index.ts
│   │   │   ├── ShimmerChar.tsx
│   │   │   ├── SpinnerAnimationRow.tsx
│   │   │   ├── SpinnerGlyph.tsx
│   │   │   ├── teammateSelectHint.ts
│   │   │   ├── TeammateSpinnerLine.tsx
│   │   │   ├── TeammateSpinnerTree.tsx
│   │   │   ├── useShimmerAnimation.ts
│   │   │   ├── useStalledAnimation.ts
│   │   │   └── utils.ts
│   │   ├── StructuredDiff
│   │   │   ├── colorDiff.ts
│   │   │   └── Fallback.tsx
│   │   ├── tasks
│   │   │   ├── AsyncAgentDetailDialog.tsx
│   │   │   ├── BackgroundTask.tsx
│   │   │   ├── BackgroundTasksDialog.tsx
│   │   │   ├── BackgroundTaskStatus.tsx
│   │   │   ├── DreamDetailDialog.tsx
│   │   │   ├── InProcessTeammateDetailDialog.tsx
│   │   │   ├── RemoteSessionDetailDialog.tsx
│   │   │   ├── RemoteSessionProgress.tsx
│   │   │   ├── renderToolActivity.tsx
│   │   │   ├── ShellDetailDialog.tsx
│   │   │   ├── ShellProgress.tsx
│   │   │   └── taskStatusUtils.tsx
│   │   ├── teams
│   │   │   ├── TeamsDialog.tsx
│   │   │   └── TeamStatus.tsx
│   │   ├── TrustDialog
│   │   │   ├── TrustDialog.tsx
│   │   │   └── utils.ts
│   │   ├── ui
│   │   │   ├── OrderedList.tsx
│   │   │   ├── OrderedListItem.tsx
│   │   │   └── TreeSelect.tsx
│   │   ├── wizard
│   │   │   ├── index.ts
│   │   │   ├── useWizard.ts
│   │   │   ├── WizardDialogLayout.tsx
│   │   │   ├── WizardNavigationFooter.tsx
│   │   │   └── WizardProvider.tsx
│   │   ├── AgentProgressLine.tsx
│   │   ├── App.tsx
│   │   ├── ApproveApiKey.tsx
│   │   ├── AutoModeOptInDialog.tsx
│   │   ├── AutoUpdater.tsx
│   │   ├── AutoUpdaterWrapper.tsx
│   │   ├── AwsAuthStatusBox.tsx
│   │   ├── BaseTextInput.tsx
│   │   ├── BashModeProgress.tsx
│   │   ├── BridgeDialog.tsx
│   │   ├── BypassPermissionsModeDialog.tsx
│   │   ├── ChannelDowngradeDialog.tsx
│   │   ├── ClaudeInChromeOnboarding.tsx
│   │   ├── ClaudeMdExternalIncludesDialog.tsx
│   │   ├── ClickableImageRef.tsx
│   │   ├── CompactSummary.tsx
│   │   ├── ConfigurableShortcutHint.tsx
│   │   ├── ConsoleOAuthFlow.tsx
│   │   ├── ContextSuggestions.tsx
│   │   ├── ContextVisualization.tsx
│   │   ├── CoordinatorAgentStatus.tsx
│   │   ├── CostThresholdDialog.tsx
│   │   ├── CtrlOToExpand.tsx
│   │   ├── DesktopHandoff.tsx
│   │   ├── DevBar.tsx
│   │   ├── DevChannelsDialog.tsx
│   │   ├── DiagnosticsDisplay.tsx
│   │   ├── EffortCallout.tsx
│   │   ├── EffortIndicator.ts
│   │   ├── ExitFlow.tsx
│   │   ├── ExportDialog.tsx
│   │   ├── FallbackToolUseErrorMessage.tsx
│   │   ├── FallbackToolUseRejectedMessage.tsx
│   │   ├── FastIcon.tsx
│   │   ├── Feedback.tsx
│   │   ├── FileEditToolDiff.tsx
│   │   ├── FileEditToolUpdatedMessage.tsx
│   │   ├── FileEditToolUseRejectedMessage.tsx
│   │   ├── FilePathLink.tsx
│   │   ├── FullscreenLayout.tsx
│   │   ├── GlobalSearchDialog.tsx
│   │   ├── HighlightedCode.tsx
│   │   ├── HistorySearchDialog.tsx
│   │   ├── IdeAutoConnectDialog.tsx
│   │   ├── IdeOnboardingDialog.tsx
│   │   ├── IdeStatusIndicator.tsx
│   │   ├── IdleReturnDialog.tsx
│   │   ├── InterruptedByUser.tsx
│   │   ├── InvalidConfigDialog.tsx
│   │   ├── InvalidSettingsDialog.tsx
│   │   ├── KeybindingWarnings.tsx
│   │   ├── LanguagePicker.tsx
│   │   ├── LogSelector.tsx
│   │   ├── Markdown.tsx
│   │   ├── MarkdownTable.tsx
│   │   ├── MCPServerApprovalDialog.tsx
│   │   ├── MCPServerDesktopImportDialog.tsx
│   │   ├── MCPServerDialogCopy.tsx
│   │   ├── MCPServerMultiselectDialog.tsx
│   │   ├── MemoryUsageIndicator.tsx
│   │   ├── Message.tsx
│   │   ├── messageActions.tsx
│   │   ├── MessageModel.tsx
│   │   ├── MessageResponse.tsx
│   │   ├── MessageRow.tsx
│   │   ├── Messages.tsx
│   │   ├── MessageSelector.tsx
│   │   ├── MessageTimestamp.tsx
│   │   ├── ModelPicker.tsx
│   │   ├── NativeAutoUpdater.tsx
│   │   ├── NotebookEditToolUseRejectedMessage.tsx
│   │   ├── OffscreenFreeze.tsx
│   │   ├── Onboarding.tsx
│   │   ├── OutputStylePicker.tsx
│   │   ├── PackageManagerAutoUpdater.tsx
│   │   ├── PrBadge.tsx
│   │   ├── PressEnterToContinue.tsx
│   │   ├── QuickOpenDialog.tsx
│   │   ├── RemoteCallout.tsx
│   │   ├── RemoteEnvironmentDialog.tsx
│   │   ├── ResumeTask.tsx
│   │   ├── SandboxViolationExpandedView.tsx
│   │   ├── ScrollKeybindingHandler.tsx
│   │   ├── SearchBox.tsx
│   │   ├── SentryErrorBoundary.ts
│   │   ├── SessionBackgroundHint.tsx
│   │   ├── SessionPreview.tsx
│   │   ├── ShowInIDEPrompt.tsx
│   │   ├── SkillImprovementSurvey.tsx
│   │   ├── Spinner.tsx
│   │   ├── Stats.tsx
│   │   ├── StatusLine.tsx
│   │   ├── StatusNotices.tsx
│   │   ├── StructuredDiff.tsx
│   │   ├── StructuredDiffList.tsx
│   │   ├── TagTabs.tsx
│   │   ├── TaskListV2.tsx
│   │   ├── TeammateViewHeader.tsx
│   │   ├── TeleportError.tsx
│   │   ├── TeleportProgress.tsx
│   │   ├── TeleportRepoMismatchDialog.tsx
│   │   ├── TeleportResumeWrapper.tsx
│   │   ├── TeleportStash.tsx
│   │   ├── TextInput.tsx
│   │   ├── ThemePicker.tsx
│   │   ├── ThinkingToggle.tsx
│   │   ├── TokenWarning.tsx
│   │   ├── ToolUseLoader.tsx
│   │   ├── ValidationErrorsList.tsx
│   │   ├── VimTextInput.tsx
│   │   ├── VirtualMessageList.tsx
│   │   ├── WorkflowMultiselectDialog.tsx
│   │   └── WorktreeExitDialog.tsx
│   ├── constants
│   │   ├── apiLimits.ts
│   │   ├── betas.ts
│   │   ├── common.ts
│   │   ├── cyberRiskInstruction.ts
│   │   ├── errorIds.ts
│   │   ├── figures.ts
│   │   ├── files.ts
│   │   ├── github-app.ts
│   │   ├── keys.ts
│   │   ├── messages.ts
│   │   ├── oauth.ts
│   │   ├── outputStyles.ts
│   │   ├── product.ts
│   │   ├── prompts.ts
│   │   ├── spinnerVerbs.ts
│   │   ├── system.ts
│   │   ├── systemPromptSections.ts
│   │   ├── toolLimits.ts
│   │   ├── tools.ts
│   │   ├── turnCompletionVerbs.ts
│   │   └── xml.ts
│   ├── context
│   │   ├── fpsMetrics.tsx
│   │   ├── mailbox.tsx
│   │   ├── modalContext.tsx
│   │   ├── notifications.tsx
│   │   ├── overlayContext.tsx
│   │   ├── promptOverlayContext.tsx
│   │   ├── QueuedMessageContext.tsx
│   │   ├── stats.tsx
│   │   └── voice.tsx
│   ├── coordinator
│   │   └── coordinatorMode.ts
│   ├── entrypoints
│   │   ├── sdk
│   │   │   ├── controlSchemas.ts
│   │   │   ├── coreSchemas.ts
│   │   │   └── coreTypes.ts
│   │   ├── agentSdkTypes.ts
│   │   ├── cli.tsx
│   │   ├── init.ts
│   │   ├── mcp.ts
│   │   └── sandboxTypes.ts
│   ├── hooks
│   │   ├── notifs
│   │   │   ├── useAutoModeUnavailableNotification.ts
│   │   │   ├── useCanSwitchToExistingSubscription.tsx
│   │   │   ├── useDeprecationWarningNotification.tsx
│   │   │   ├── useFastModeNotification.tsx
│   │   │   ├── useIDEStatusIndicator.tsx
│   │   │   ├── useInstallMessages.tsx
│   │   │   ├── useLspInitializationNotification.tsx
│   │   │   ├── useMcpConnectivityStatus.tsx
│   │   │   ├── useModelMigrationNotifications.tsx
│   │   │   ├── useNpmDeprecationNotification.tsx
│   │   │   ├── usePluginAutoupdateNotification.tsx
│   │   │   ├── usePluginInstallationStatus.tsx
│   │   │   ├── useRateLimitWarningNotification.tsx
│   │   │   ├── useSettingsErrors.tsx
│   │   │   ├── useStartupNotification.ts
│   │   │   └── useTeammateShutdownNotification.ts
│   │   ├── toolPermission
│   │   │   ├── handlers
│   │   │   │   ├── coordinatorHandler.ts
│   │   │   │   ├── interactiveHandler.ts
│   │   │   │   └── swarmWorkerHandler.ts
│   │   │   ├── PermissionContext.ts
│   │   │   └── permissionLogging.ts
│   │   ├── fileSuggestions.ts
│   │   ├── renderPlaceholder.ts
│   │   ├── unifiedSuggestions.ts
│   │   ├── useAfterFirstRender.ts
│   │   ├── useApiKeyVerification.ts
│   │   ├── useArrowKeyHistory.tsx
│   │   ├── useAssistantHistory.ts
│   │   ├── useAwaySummary.ts
│   │   ├── useBackgroundTaskNavigation.ts
│   │   ├── useBlink.ts
│   │   ├── useCancelRequest.ts
│   │   ├── useCanUseTool.tsx
│   │   ├── useChromeExtensionNotification.tsx
│   │   ├── useClaudeCodeHintRecommendation.tsx
│   │   ├── useClipboardImageHint.ts
│   │   ├── useCommandKeybindings.tsx
│   │   ├── useCommandQueue.ts
│   │   ├── useCopyOnSelect.ts
│   │   ├── useDeferredHookMessages.ts
│   │   ├── useDiffData.ts
│   │   ├── useDiffInIDE.ts
│   │   ├── useDirectConnect.ts
│   │   ├── useDoublePress.ts
│   │   ├── useDynamicConfig.ts
│   │   ├── useElapsedTime.ts
│   │   ├── useExitOnCtrlCD.ts
│   │   ├── useExitOnCtrlCDWithKeybindings.ts
│   │   ├── useFileHistorySnapshotInit.ts
│   │   ├── useGlobalKeybindings.tsx
│   │   ├── useHistorySearch.ts
│   │   ├── useIdeAtMentioned.ts
│   │   ├── useIdeConnectionStatus.ts
│   │   ├── useIDEIntegration.tsx
│   │   ├── useIdeLogging.ts
│   │   ├── useIdeSelection.ts
│   │   ├── useInboxPoller.ts
│   │   ├── useInputBuffer.ts
│   │   ├── useIssueFlagBanner.ts
│   │   ├── useLogMessages.ts
│   │   ├── useLspPluginRecommendation.tsx
│   │   ├── useMailboxBridge.ts
│   │   ├── useMainLoopModel.ts
│   │   ├── useManagePlugins.ts
│   │   ├── useMemoryUsage.ts
│   │   ├── useMergedClients.ts
│   │   ├── useMergedCommands.ts
│   │   ├── useMergedTools.ts
│   │   ├── useMinDisplayTime.ts
│   │   ├── useNotifyAfterTimeout.ts
│   │   ├── useOfficialMarketplaceNotification.tsx
│   │   ├── usePasteHandler.ts
│   │   ├── usePluginRecommendationBase.tsx
│   │   ├── usePromptsFromClaudeInChrome.tsx
│   │   ├── usePromptSuggestion.ts
│   │   ├── usePrStatus.ts
│   │   ├── useQueueProcessor.ts
│   │   ├── useRemoteSession.ts
│   │   ├── useReplBridge.tsx
│   │   ├── useScheduledTasks.ts
│   │   ├── useSearchInput.ts
│   │   ├── useSessionBackgrounding.ts
│   │   ├── useSettings.ts
│   │   ├── useSettingsChange.ts
│   │   ├── useSkillImprovementSurvey.ts
│   │   ├── useSkillsChange.ts
│   │   ├── useSSHSession.ts
│   │   ├── useSwarmInitialization.ts
│   │   ├── useSwarmPermissionPoller.ts
│   │   ├── useTaskListWatcher.ts
│   │   ├── useTasksV2.ts
│   │   ├── useTeammateViewAutoExit.ts
│   │   ├── useTeleportResume.tsx
│   │   ├── useTerminalSize.ts
│   │   ├── useTextInput.ts
│   │   ├── useTimeout.ts
│   │   ├── useTurnDiffs.ts
│   │   ├── useTypeahead.tsx
│   │   ├── useUpdateNotification.ts
│   │   ├── useVimInput.ts
│   │   ├── useVirtualScroll.ts
│   │   ├── useVoice.ts
│   │   ├── useVoiceEnabled.ts
│   │   └── useVoiceIntegration.tsx
│   ├── ink
│   │   ├── components
│   │   │   ├── AlternateScreen.tsx
│   │   │   ├── App.tsx
│   │   │   ├── AppContext.ts
│   │   │   ├── Box.tsx
│   │   │   ├── Button.tsx
│   │   │   ├── ClockContext.tsx
│   │   │   ├── CursorDeclarationContext.ts
│   │   │   ├── ErrorOverview.tsx
│   │   │   ├── Link.tsx
│   │   │   ├── Newline.tsx
│   │   │   ├── NoSelect.tsx
│   │   │   ├── RawAnsi.tsx
│   │   │   ├── ScrollBox.tsx
│   │   │   ├── Spacer.tsx
│   │   │   ├── StdinContext.ts
│   │   │   ├── TerminalFocusContext.tsx
│   │   │   ├── TerminalSizeContext.tsx
│   │   │   └── Text.tsx
│   │   ├── events
│   │   │   ├── click-event.ts
│   │   │   ├── dispatcher.ts
│   │   │   ├── emitter.ts
│   │   │   ├── event-handlers.ts
│   │   │   ├── event.ts
│   │   │   ├── focus-event.ts
│   │   │   ├── input-event.ts
│   │   │   ├── keyboard-event.ts
│   │   │   ├── terminal-event.ts
│   │   │   └── terminal-focus-event.ts
│   │   ├── hooks
│   │   │   ├── use-animation-frame.ts
│   │   │   ├── use-app.ts
│   │   │   ├── use-declared-cursor.ts
│   │   │   ├── use-input.ts
│   │   │   ├── use-interval.ts
│   │   │   ├── use-search-highlight.ts
│   │   │   ├── use-selection.ts
│   │   │   ├── use-stdin.ts
│   │   │   ├── use-tab-status.ts
│   │   │   ├── use-terminal-focus.ts
│   │   │   ├── use-terminal-title.ts
│   │   │   └── use-terminal-viewport.ts
│   │   ├── layout
│   │   │   ├── engine.ts
│   │   │   ├── geometry.ts
│   │   │   ├── node.ts
│   │   │   └── yoga.ts
│   │   ├── termio
│   │   │   ├── ansi.ts
│   │   │   ├── csi.ts
│   │   │   ├── dec.ts
│   │   │   ├── esc.ts
│   │   │   ├── osc.ts
│   │   │   ├── parser.ts
│   │   │   ├── sgr.ts
│   │   │   ├── tokenize.ts
│   │   │   └── types.ts
│   │   ├── Ansi.tsx
│   │   ├── bidi.ts
│   │   ├── clearTerminal.ts
│   │   ├── colorize.ts
│   │   ├── constants.ts
│   │   ├── dom.ts
│   │   ├── focus.ts
│   │   ├── frame.ts
│   │   ├── get-max-width.ts
│   │   ├── hit-test.ts
│   │   ├── ink.tsx
│   │   ├── instances.ts
│   │   ├── line-width-cache.ts
│   │   ├── log-update.ts
│   │   ├── measure-element.ts
│   │   ├── measure-text.ts
│   │   ├── node-cache.ts
│   │   ├── optimizer.ts
│   │   ├── output.ts
│   │   ├── parse-keypress.ts
│   │   ├── reconciler.ts
│   │   ├── render-border.ts
│   │   ├── render-node-to-output.ts
│   │   ├── render-to-screen.ts
│   │   ├── renderer.ts
│   │   ├── root.ts
│   │   ├── screen.ts
│   │   ├── searchHighlight.ts
│   │   ├── selection.ts
│   │   ├── squash-text-nodes.ts
│   │   ├── stringWidth.ts
│   │   ├── styles.ts
│   │   ├── supports-hyperlinks.ts
│   │   ├── tabstops.ts
│   │   ├── terminal-focus-state.ts
│   │   ├── terminal-querier.ts
│   │   ├── terminal.ts
│   │   ├── termio.ts
│   │   ├── useTerminalNotification.ts
│   │   ├── warn.ts
│   │   ├── widest-line.ts
│   │   ├── wrap-text.ts
│   │   └── wrapAnsi.ts
│   ├── keybindings
│   │   ├── defaultBindings.ts
│   │   ├── KeybindingContext.tsx
│   │   ├── KeybindingProviderSetup.tsx
│   │   ├── loadUserBindings.ts
│   │   ├── match.ts
│   │   ├── parser.ts
│   │   ├── reservedShortcuts.ts
│   │   ├── resolver.ts
│   │   ├── schema.ts
│   │   ├── shortcutFormat.ts
│   │   ├── template.ts
│   │   ├── useKeybinding.ts
│   │   ├── useShortcutDisplay.ts
│   │   └── validate.ts
│   ├── memdir
│   │   ├── findRelevantMemories.ts
│   │   ├── memdir.ts
│   │   ├── memoryAge.ts
│   │   ├── memoryScan.ts
│   │   ├── memoryTypes.ts
│   │   ├── paths.ts
│   │   ├── teamMemPaths.ts
│   │   └── teamMemPrompts.ts
│   ├── migrations
│   │   ├── migrateAutoUpdatesToSettings.ts
│   │   ├── migrateBypassPermissionsAcceptedToSettings.ts
│   │   ├── migrateEnableAllProjectMcpServersToSettings.ts
│   │   ├── migrateFennecToOpus.ts
│   │   ├── migrateLegacyOpusToCurrent.ts
│   │   ├── migrateOpusToOpus1m.ts
│   │   ├── migrateReplBridgeEnabledToRemoteControlAtStartup.ts
│   │   ├── migrateSonnet1mToSonnet45.ts
│   │   ├── migrateSonnet45ToSonnet46.ts
│   │   ├── resetAutoModeOptInForDefaultOffer.ts
│   │   └── resetProToOpusDefault.ts
│   ├── moreright
│   │   └── useMoreRight.tsx
│   ├── native-ts
│   │   ├── color-diff
│   │   │   └── index.ts
│   │   ├── file-index
│   │   │   └── index.ts
│   │   └── yoga-layout
│   │       ├── enums.ts
│   │       └── index.ts
│   ├── outputStyles
│   │   └── loadOutputStylesDir.ts
│   ├── plugins
│   │   ├── bundled
│   │   │   └── index.ts
│   │   └── builtinPlugins.ts
│   ├── query
│   │   ├── config.ts
│   │   ├── deps.ts
│   │   ├── stopHooks.ts
│   │   └── tokenBudget.ts
│   ├── remote
│   │   ├── remotePermissionBridge.ts
│   │   ├── RemoteSessionManager.ts
│   │   ├── sdkMessageAdapter.ts
│   │   └── SessionsWebSocket.ts
│   ├── schemas
│   │   └── hooks.ts
│   ├── screens
│   │   ├── Doctor.tsx
│   │   ├── REPL.tsx
│   │   └── ResumeConversation.tsx
│   ├── server
│   │   ├── createDirectConnectSession.ts
│   │   ├── directConnectManager.ts
│   │   └── types.ts
│   ├── services
│   │   ├── AgentSummary
│   │   │   └── agentSummary.ts
│   │   ├── analytics
│   │   │   ├── config.ts
│   │   │   ├── datadog.ts
│   │   │   ├── firstPartyEventLogger.ts
│   │   │   ├── firstPartyEventLoggingExporter.ts
│   │   │   ├── growthbook.ts
│   │   │   ├── index.ts
│   │   │   ├── metadata.ts
│   │   │   ├── sink.ts
│   │   │   └── sinkKillswitch.ts
│   │   ├── api
│   │   │   ├── adminRequests.ts
│   │   │   ├── bootstrap.ts
│   │   │   ├── claude.ts
│   │   │   ├── client.ts
│   │   │   ├── dumpPrompts.ts
│   │   │   ├── emptyUsage.ts
│   │   │   ├── errors.ts
│   │   │   ├── errorUtils.ts
│   │   │   ├── filesApi.ts
│   │   │   ├── firstTokenDate.ts
│   │   │   ├── grove.ts
│   │   │   ├── logging.ts
│   │   │   ├── metricsOptOut.ts
│   │   │   ├── overageCreditGrant.ts
│   │   │   ├── promptCacheBreakDetection.ts
│   │   │   ├── referral.ts
│   │   │   ├── sessionIngress.ts
│   │   │   ├── ultrareviewQuota.ts
│   │   │   ├── usage.ts
│   │   │   └── withRetry.ts
│   │   ├── autoDream
│   │   │   ├── autoDream.ts
│   │   │   ├── config.ts
│   │   │   ├── consolidationLock.ts
│   │   │   └── consolidationPrompt.ts
│   │   ├── compact
│   │   │   ├── apiMicrocompact.ts
│   │   │   ├── autoCompact.ts
│   │   │   ├── compact.ts
│   │   │   ├── compactWarningHook.ts
│   │   │   ├── compactWarningState.ts
│   │   │   ├── grouping.ts
│   │   │   ├── microCompact.ts
│   │   │   ├── postCompactCleanup.ts
│   │   │   ├── prompt.ts
│   │   │   ├── sessionMemoryCompact.ts
│   │   │   └── timeBasedMCConfig.ts
│   │   ├── extractMemories
│   │   │   ├── extractMemories.ts
│   │   │   └── prompts.ts
│   │   ├── lsp
│   │   │   ├── config.ts
│   │   │   ├── LSPClient.ts
│   │   │   ├── LSPDiagnosticRegistry.ts
│   │   │   ├── LSPServerInstance.ts
│   │   │   ├── LSPServerManager.ts
│   │   │   ├── manager.ts
│   │   │   └── passiveFeedback.ts
│   │   ├── MagicDocs
│   │   │   ├── magicDocs.ts
│   │   │   └── prompts.ts
│   │   ├── mcp
│   │   │   ├── auth.ts
│   │   │   ├── channelAllowlist.ts
│   │   │   ├── channelNotification.ts
│   │   │   ├── channelPermissions.ts
│   │   │   ├── claudeai.ts
│   │   │   ├── client.ts
│   │   │   ├── config.ts
│   │   │   ├── elicitationHandler.ts
│   │   │   ├── envExpansion.ts
│   │   │   ├── headersHelper.ts
│   │   │   ├── InProcessTransport.ts
│   │   │   ├── MCPConnectionManager.tsx
│   │   │   ├── mcpStringUtils.ts
│   │   │   ├── normalization.ts
│   │   │   ├── oauthPort.ts
│   │   │   ├── officialRegistry.ts
│   │   │   ├── SdkControlTransport.ts
│   │   │   ├── types.ts
│   │   │   ├── useManageMCPConnections.ts
│   │   │   ├── utils.ts
│   │   │   ├── vscodeSdkMcp.ts
│   │   │   ├── xaa.ts
│   │   │   └── xaaIdpLogin.ts
│   │   ├── oauth
│   │   │   ├── auth-code-listener.ts
│   │   │   ├── client.ts
│   │   │   ├── crypto.ts
│   │   │   ├── getOauthProfile.ts
│   │   │   └── index.ts
│   │   ├── plugins
│   │   │   ├── pluginCliCommands.ts
│   │   │   ├── PluginInstallationManager.ts
│   │   │   └── pluginOperations.ts
│   │   ├── policyLimits
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── PromptSuggestion
│   │   │   ├── promptSuggestion.ts
│   │   │   └── speculation.ts
│   │   ├── remoteManagedSettings
│   │   │   ├── index.ts
│   │   │   ├── securityCheck.tsx
│   │   │   ├── syncCache.ts
│   │   │   ├── syncCacheState.ts
│   │   │   └── types.ts
│   │   ├── SessionMemory
│   │   │   ├── prompts.ts
│   │   │   ├── sessionMemory.ts
│   │   │   └── sessionMemoryUtils.ts
│   │   ├── settingsSync
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── teamMemorySync
│   │   │   ├── index.ts
│   │   │   ├── secretScanner.ts
│   │   │   ├── teamMemSecretGuard.ts
│   │   │   ├── types.ts
│   │   │   └── watcher.ts
│   │   ├── tips
│   │   │   ├── tipHistory.ts
│   │   │   ├── tipRegistry.ts
│   │   │   └── tipScheduler.ts
│   │   ├── tools
│   │   │   ├── StreamingToolExecutor.ts
│   │   │   ├── toolExecution.ts
│   │   │   ├── toolHooks.ts
│   │   │   └── toolOrchestration.ts
│   │   ├── toolUseSummary
│   │   │   └── toolUseSummaryGenerator.ts
│   │   ├── awaySummary.ts
│   │   ├── claudeAiLimits.ts
│   │   ├── claudeAiLimitsHook.ts
│   │   ├── diagnosticTracking.ts
│   │   ├── internalLogging.ts
│   │   ├── mcpServerApproval.tsx
│   │   ├── mockRateLimits.ts
│   │   ├── notifier.ts
│   │   ├── preventSleep.ts
│   │   ├── rateLimitMessages.ts
│   │   ├── rateLimitMocking.ts
│   │   ├── tokenEstimation.ts
│   │   ├── vcr.ts
│   │   ├── voice.ts
│   │   ├── voiceKeyterms.ts
│   │   └── voiceStreamSTT.ts
│   ├── skills
│   │   ├── bundled
│   │   │   ├── batch.ts
│   │   │   ├── claudeApi.ts
│   │   │   ├── claudeApiContent.ts
│   │   │   ├── claudeInChrome.ts
│   │   │   ├── debug.ts
│   │   │   ├── index.ts
│   │   │   ├── keybindings.ts
│   │   │   ├── loop.ts
│   │   │   ├── loremIpsum.ts
│   │   │   ├── remember.ts
│   │   │   ├── scheduleRemoteAgents.ts
│   │   │   ├── simplify.ts
│   │   │   ├── skillify.ts
│   │   │   ├── stuck.ts
│   │   │   ├── updateConfig.ts
│   │   │   ├── verify.ts
│   │   │   └── verifyContent.ts
│   │   ├── bundledSkills.ts
│   │   ├── loadSkillsDir.ts
│   │   └── mcpSkillBuilders.ts
│   ├── state
│   │   ├── AppState.tsx
│   │   ├── AppStateStore.ts
│   │   ├── onChangeAppState.ts
│   │   ├── selectors.ts
│   │   ├── store.ts
│   │   └── teammateViewHelpers.ts
│   ├── tasks
│   │   ├── DreamTask
│   │   │   └── DreamTask.ts
│   │   ├── InProcessTeammateTask
│   │   │   ├── InProcessTeammateTask.tsx
│   │   │   └── types.ts
│   │   ├── LocalAgentTask
│   │   │   └── LocalAgentTask.tsx
│   │   ├── LocalShellTask
│   │   │   ├── guards.ts
│   │   │   ├── killShellTasks.ts
│   │   │   └── LocalShellTask.tsx
│   │   ├── RemoteAgentTask
│   │   │   └── RemoteAgentTask.tsx
│   │   ├── LocalMainSessionTask.ts
│   │   ├── pillLabel.ts
│   │   ├── stopTask.ts
│   │   └── types.ts
│   ├── tools
│   │   ├── AgentTool
│   │   │   ├── built-in
│   │   │   │   ├── claudeCodeGuideAgent.ts
│   │   │   │   ├── exploreAgent.ts
│   │   │   │   ├── generalPurposeAgent.ts
│   │   │   │   ├── planAgent.ts
│   │   │   │   ├── statuslineSetup.ts
│   │   │   │   └── verificationAgent.ts
│   │   │   ├── agentColorManager.ts
│   │   │   ├── agentDisplay.ts
│   │   │   ├── agentMemory.ts
│   │   │   ├── agentMemorySnapshot.ts
│   │   │   ├── AgentTool.tsx
│   │   │   ├── agentToolUtils.ts
│   │   │   ├── builtInAgents.ts
│   │   │   ├── constants.ts
│   │   │   ├── forkSubagent.ts
│   │   │   ├── loadAgentsDir.ts
│   │   │   ├── prompt.ts
│   │   │   ├── resumeAgent.ts
│   │   │   ├── runAgent.ts
│   │   │   └── UI.tsx
│   │   ├── AskUserQuestionTool
│   │   │   ├── AskUserQuestionTool.tsx
│   │   │   └── prompt.ts
│   │   ├── BashTool
│   │   │   ├── bashCommandHelpers.ts
│   │   │   ├── bashPermissions.ts
│   │   │   ├── bashSecurity.ts
│   │   │   ├── BashTool.tsx
│   │   │   ├── BashToolResultMessage.tsx
│   │   │   ├── commandSemantics.ts
│   │   │   ├── commentLabel.ts
│   │   │   ├── destructiveCommandWarning.ts
│   │   │   ├── modeValidation.ts
│   │   │   ├── pathValidation.ts
│   │   │   ├── prompt.ts
│   │   │   ├── readOnlyValidation.ts
│   │   │   ├── sedEditParser.ts
│   │   │   ├── sedValidation.ts
│   │   │   ├── shouldUseSandbox.ts
│   │   │   ├── toolName.ts
│   │   │   ├── UI.tsx
│   │   │   └── utils.ts
│   │   ├── BriefTool
│   │   │   ├── attachments.ts
│   │   │   ├── BriefTool.ts
│   │   │   ├── prompt.ts
│   │   │   ├── UI.tsx
│   │   │   └── upload.ts
│   │   ├── ConfigTool
│   │   │   ├── ConfigTool.ts
│   │   │   ├── constants.ts
│   │   │   ├── prompt.ts
│   │   │   ├── supportedSettings.ts
│   │   │   └── UI.tsx
│   │   ├── EnterPlanModeTool
│   │   │   ├── constants.ts
│   │   │   ├── EnterPlanModeTool.ts
│   │   │   ├── prompt.ts
│   │   │   └── UI.tsx
│   │   ├── EnterWorktreeTool
│   │   │   ├── constants.ts
│   │   │   ├── EnterWorktreeTool.ts
│   │   │   ├── prompt.ts
│   │   │   └── UI.tsx
│   │   ├── ExitPlanModeTool
│   │   │   ├── constants.ts
│   │   │   ├── ExitPlanModeV2Tool.ts
│   │   │   ├── prompt.ts
│   │   │   └── UI.tsx
│   │   ├── ExitWorktreeTool
│   │   │   ├── constants.ts
│   │   │   ├── ExitWorktreeTool.ts
│   │   │   ├── prompt.ts
│   │   │   └── UI.tsx
│   │   ├── FileEditTool
│   │   │   ├── constants.ts
│   │   │   ├── FileEditTool.ts
│   │   │   ├── prompt.ts
│   │   │   ├── types.ts
│   │   │   ├── UI.tsx
│   │   │   └── utils.ts
│   │   ├── FileReadTool
│   │   │   ├── FileReadTool.ts
│   │   │   ├── imageProcessor.ts
│   │   │   ├── limits.ts
│   │   │   ├── prompt.ts
│   │   │   └── UI.tsx
│   │   ├── FileWriteTool
│   │   │   ├── FileWriteTool.ts
│   │   │   ├── prompt.ts
│   │   │   └── UI.tsx
│   │   ├── GlobTool
│   │   │   ├── GlobTool.ts
│   │   │   ├── prompt.ts
│   │   │   └── UI.tsx
│   │   ├── GrepTool
│   │   │   ├── GrepTool.ts
│   │   │   ├── prompt.ts
│   │   │   └── UI.tsx
│   │   ├── ListMcpResourcesTool
│   │   │   ├── ListMcpResourcesTool.ts
│   │   │   ├── prompt.ts
│   │   │   └── UI.tsx
│   │   ├── LSPTool
│   │   │   ├── formatters.ts
│   │   │   ├── LSPTool.ts
│   │   │   ├── prompt.ts
│   │   │   ├── schemas.ts
│   │   │   ├── symbolContext.ts
│   │   │   └── UI.tsx
│   │   ├── McpAuthTool
│   │   │   └── McpAuthTool.ts
│   │   ├── MCPTool
│   │   │   ├── classifyForCollapse.ts
│   │   │   ├── MCPTool.ts
│   │   │   ├── prompt.ts
│   │   │   └── UI.tsx
│   │   ├── NotebookEditTool
│   │   │   ├── constants.ts
│   │   │   ├── NotebookEditTool.ts
│   │   │   ├── prompt.ts
│   │   │   └── UI.tsx
│   │   ├── PowerShellTool
│   │   │   ├── clmTypes.ts
│   │   │   ├── commandSemantics.ts
│   │   │   ├── commonParameters.ts
│   │   │   ├── destructiveCommandWarning.ts
│   │   │   ├── gitSafety.ts
│   │   │   ├── modeValidation.ts
│   │   │   ├── pathValidation.ts
│   │   │   ├── powershellPermissions.ts
│   │   │   ├── powershellSecurity.ts
│   │   │   ├── PowerShellTool.tsx
│   │   │   ├── prompt.ts
│   │   │   ├── readOnlyValidation.ts
│   │   │   ├── toolName.ts
│   │   │   └── UI.tsx
│   │   ├── ReadMcpResourceTool
│   │   │   ├── prompt.ts
│   │   │   ├── ReadMcpResourceTool.ts
│   │   │   └── UI.tsx
│   │   ├── RemoteTriggerTool
│   │   │   ├── prompt.ts
│   │   │   ├── RemoteTriggerTool.ts
│   │   │   └── UI.tsx
│   │   ├── REPLTool
│   │   │   ├── constants.ts
│   │   │   └── primitiveTools.ts
│   │   ├── ScheduleCronTool
│   │   │   ├── CronCreateTool.ts
│   │   │   ├── CronDeleteTool.ts
│   │   │   ├── CronListTool.ts
│   │   │   ├── prompt.ts
│   │   │   └── UI.tsx
│   │   ├── SendMessageTool
│   │   │   ├── constants.ts
│   │   │   ├── prompt.ts
│   │   │   ├── SendMessageTool.ts
│   │   │   └── UI.tsx
│   │   ├── shared
│   │   │   ├── gitOperationTracking.ts
│   │   │   └── spawnMultiAgent.ts
│   │   ├── SkillTool
│   │   │   ├── constants.ts
│   │   │   ├── prompt.ts
│   │   │   ├── SkillTool.ts
│   │   │   └── UI.tsx
│   │   ├── SleepTool
│   │   │   └── prompt.ts
│   │   ├── SyntheticOutputTool
│   │   │   └── SyntheticOutputTool.ts
│   │   ├── TaskCreateTool
│   │   │   ├── constants.ts
│   │   │   ├── prompt.ts
│   │   │   └── TaskCreateTool.ts
│   │   ├── TaskGetTool
│   │   │   ├── constants.ts
│   │   │   ├── prompt.ts
│   │   │   └── TaskGetTool.ts
│   │   ├── TaskListTool
│   │   │   ├── constants.ts
│   │   │   ├── prompt.ts
│   │   │   └── TaskListTool.ts
│   │   ├── TaskOutputTool
│   │   │   ├── constants.ts
│   │   │   └── TaskOutputTool.tsx
│   │   ├── TaskStopTool
│   │   │   ├── prompt.ts
│   │   │   ├── TaskStopTool.ts
│   │   │   └── UI.tsx
│   │   ├── TaskUpdateTool
│   │   │   ├── constants.ts
│   │   │   ├── prompt.ts
│   │   │   └── TaskUpdateTool.ts
│   │   ├── TeamCreateTool
│   │   │   ├── constants.ts
│   │   │   ├── prompt.ts
│   │   │   ├── TeamCreateTool.ts
│   │   │   └── UI.tsx
│   │   ├── TeamDeleteTool
│   │   │   ├── constants.ts
│   │   │   ├── prompt.ts
│   │   │   ├── TeamDeleteTool.ts
│   │   │   └── UI.tsx
│   │   ├── testing
│   │   │   └── TestingPermissionTool.tsx
│   │   ├── TodoWriteTool
│   │   │   ├── constants.ts
│   │   │   ├── prompt.ts
│   │   │   └── TodoWriteTool.ts
│   │   ├── ToolSearchTool
│   │   │   ├── constants.ts
│   │   │   ├── prompt.ts
│   │   │   └── ToolSearchTool.ts
│   │   ├── WebFetchTool
│   │   │   ├── preapproved.ts
│   │   │   ├── prompt.ts
│   │   │   ├── UI.tsx
│   │   │   ├── utils.ts
│   │   │   └── WebFetchTool.ts
│   │   ├── WebSearchTool
│   │   │   ├── prompt.ts
│   │   │   ├── UI.tsx
│   │   │   └── WebSearchTool.ts
│   │   └── utils.ts
│   ├── types
│   │   ├── generated
│   │   │   ├── events_mono
│   │   │   │   ├── claude_code
│   │   │   │   │   └── v1
│   │   │   │   │       └── claude_code_internal_event.ts
│   │   │   │   ├── common
│   │   │   │   │   └── v1
│   │   │   │   │       └── auth.ts
│   │   │   │   └── growthbook
│   │   │   │       └── v1
│   │   │   │           └── growthbook_experiment_event.ts
│   │   │   └── google
│   │   │       └── protobuf
│   │   │           └── timestamp.ts
│   │   ├── command.ts
│   │   ├── hooks.ts
│   │   ├── ids.ts
│   │   ├── logs.ts
│   │   ├── permissions.ts
│   │   ├── plugin.ts
│   │   └── textInputTypes.ts
│   ├── upstreamproxy
│   │   ├── relay.ts
│   │   └── upstreamproxy.ts
│   ├── utils
│   │   ├── background
│   │   │   └── remote
│   │   │       ├── preconditions.ts
│   │   │       └── remoteSession.ts
│   │   ├── bash
│   │   │   ├── specs
│   │   │   │   ├── alias.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── nohup.ts
│   │   │   │   ├── pyright.ts
│   │   │   │   ├── sleep.ts
│   │   │   │   ├── srun.ts
│   │   │   │   ├── time.ts
│   │   │   │   └── timeout.ts
│   │   │   ├── ast.ts
│   │   │   ├── bashParser.ts
│   │   │   ├── bashPipeCommand.ts
│   │   │   ├── commands.ts
│   │   │   ├── heredoc.ts
│   │   │   ├── ParsedCommand.ts
│   │   │   ├── parser.ts
│   │   │   ├── prefix.ts
│   │   │   ├── registry.ts
│   │   │   ├── shellCompletion.ts
│   │   │   ├── shellPrefix.ts
│   │   │   ├── shellQuote.ts
│   │   │   ├── shellQuoting.ts
│   │   │   ├── ShellSnapshot.ts
│   │   │   └── treeSitterAnalysis.ts
│   │   ├── claudeInChrome
│   │   │   ├── chromeNativeHost.ts
│   │   │   ├── common.ts
│   │   │   ├── mcpServer.ts
│   │   │   ├── prompt.ts
│   │   │   ├── setup.ts
│   │   │   ├── setupPortable.ts
│   │   │   └── toolRendering.tsx
│   │   ├── computerUse
│   │   │   ├── appNames.ts
│   │   │   ├── cleanup.ts
│   │   │   ├── common.ts
│   │   │   ├── computerUseLock.ts
│   │   │   ├── drainRunLoop.ts
│   │   │   ├── escHotkey.ts
│   │   │   ├── executor.ts
│   │   │   ├── gates.ts
│   │   │   ├── hostAdapter.ts
│   │   │   ├── inputLoader.ts
│   │   │   ├── mcpServer.ts
│   │   │   ├── setup.ts
│   │   │   ├── swiftLoader.ts
│   │   │   ├── toolRendering.tsx
│   │   │   └── wrapper.tsx
│   │   ├── deepLink
│   │   │   ├── banner.ts
│   │   │   ├── parseDeepLink.ts
│   │   │   ├── protocolHandler.ts
│   │   │   ├── registerProtocol.ts
│   │   │   ├── terminalLauncher.ts
│   │   │   └── terminalPreference.ts
│   │   ├── dxt
│   │   │   ├── helpers.ts
│   │   │   └── zip.ts
│   │   ├── filePersistence
│   │   │   ├── filePersistence.ts
│   │   │   └── outputsScanner.ts
│   │   ├── git
│   │   │   ├── gitConfigParser.ts
│   │   │   ├── gitFilesystem.ts
│   │   │   └── gitignore.ts
│   │   ├── github
│   │   │   └── ghAuthStatus.ts
│   │   ├── hooks
│   │   │   ├── apiQueryHookHelper.ts
│   │   │   ├── AsyncHookRegistry.ts
│   │   │   ├── execAgentHook.ts
│   │   │   ├── execHttpHook.ts
│   │   │   ├── execPromptHook.ts
│   │   │   ├── fileChangedWatcher.ts
│   │   │   ├── hookEvents.ts
│   │   │   ├── hookHelpers.ts
│   │   │   ├── hooksConfigManager.ts
│   │   │   ├── hooksConfigSnapshot.ts
│   │   │   ├── hooksSettings.ts
│   │   │   ├── postSamplingHooks.ts
│   │   │   ├── registerFrontmatterHooks.ts
│   │   │   ├── registerSkillHooks.ts
│   │   │   ├── sessionHooks.ts
│   │   │   ├── skillImprovement.ts
│   │   │   └── ssrfGuard.ts
│   │   ├── mcp
│   │   │   ├── dateTimeParser.ts
│   │   │   └── elicitationValidation.ts
│   │   ├── memory
│   │   │   ├── types.ts
│   │   │   └── versions.ts
│   │   ├── messages
│   │   │   ├── mappers.ts
│   │   │   └── systemInit.ts
│   │   ├── model
│   │   │   ├── agent.ts
│   │   │   ├── aliases.ts
│   │   │   ├── antModels.ts
│   │   │   ├── bedrock.ts
│   │   │   ├── check1mAccess.ts
│   │   │   ├── configs.ts
│   │   │   ├── contextWindowUpgradeCheck.ts
│   │   │   ├── deprecation.ts
│   │   │   ├── model.ts
│   │   │   ├── modelAllowlist.ts
│   │   │   ├── modelCapabilities.ts
│   │   │   ├── modelOptions.ts
│   │   │   ├── modelStrings.ts
│   │   │   ├── modelSupportOverrides.ts
│   │   │   ├── providers.ts
│   │   │   └── validateModel.ts
│   │   ├── nativeInstaller
│   │   │   ├── download.ts
│   │   │   ├── index.ts
│   │   │   ├── installer.ts
│   │   │   ├── packageManagers.ts
│   │   │   └── pidLock.ts
│   │   ├── permissions
│   │   │   ├── autoModeState.ts
│   │   │   ├── bashClassifier.ts
│   │   │   ├── bypassPermissionsKillswitch.ts
│   │   │   ├── classifierDecision.ts
│   │   │   ├── classifierShared.ts
│   │   │   ├── dangerousPatterns.ts
│   │   │   ├── denialTracking.ts
│   │   │   ├── filesystem.ts
│   │   │   ├── getNextPermissionMode.ts
│   │   │   ├── pathValidation.ts
│   │   │   ├── permissionExplainer.ts
│   │   │   ├── PermissionMode.ts
│   │   │   ├── PermissionPromptToolResultSchema.ts
│   │   │   ├── PermissionResult.ts
│   │   │   ├── PermissionRule.ts
│   │   │   ├── permissionRuleParser.ts
│   │   │   ├── permissions.ts
│   │   │   ├── permissionSetup.ts
│   │   │   ├── permissionsLoader.ts
│   │   │   ├── PermissionUpdate.ts
│   │   │   ├── PermissionUpdateSchema.ts
│   │   │   ├── shadowedRuleDetection.ts
│   │   │   ├── shellRuleMatching.ts
│   │   │   └── yoloClassifier.ts
│   │   ├── plugins
│   │   │   ├── addDirPluginSettings.ts
│   │   │   ├── cacheUtils.ts
│   │   │   ├── dependencyResolver.ts
│   │   │   ├── fetchTelemetry.ts
│   │   │   ├── gitAvailability.ts
│   │   │   ├── headlessPluginInstall.ts
│   │   │   ├── hintRecommendation.ts
│   │   │   ├── installCounts.ts
│   │   │   ├── installedPluginsManager.ts
│   │   │   ├── loadPluginAgents.ts
│   │   │   ├── loadPluginCommands.ts
│   │   │   ├── loadPluginHooks.ts
│   │   │   ├── loadPluginOutputStyles.ts
│   │   │   ├── lspPluginIntegration.ts
│   │   │   ├── lspRecommendation.ts
│   │   │   ├── managedPlugins.ts
│   │   │   ├── marketplaceHelpers.ts
│   │   │   ├── marketplaceManager.ts
│   │   │   ├── mcpbHandler.ts
│   │   │   ├── mcpPluginIntegration.ts
│   │   │   ├── officialMarketplace.ts
│   │   │   ├── officialMarketplaceGcs.ts
│   │   │   ├── officialMarketplaceStartupCheck.ts
│   │   │   ├── orphanedPluginFilter.ts
│   │   │   ├── parseMarketplaceInput.ts
│   │   │   ├── performStartupChecks.tsx
│   │   │   ├── pluginAutoupdate.ts
│   │   │   ├── pluginBlocklist.ts
│   │   │   ├── pluginDirectories.ts
│   │   │   ├── pluginFlagging.ts
│   │   │   ├── pluginIdentifier.ts
│   │   │   ├── pluginInstallationHelpers.ts
│   │   │   ├── pluginLoader.ts
│   │   │   ├── pluginOptionsStorage.ts
│   │   │   ├── pluginPolicy.ts
│   │   │   ├── pluginStartupCheck.ts
│   │   │   ├── pluginVersioning.ts
│   │   │   ├── reconciler.ts
│   │   │   ├── refresh.ts
│   │   │   ├── schemas.ts
│   │   │   ├── validatePlugin.ts
│   │   │   ├── walkPluginMarkdown.ts
│   │   │   ├── zipCache.ts
│   │   │   └── zipCacheAdapters.ts
│   │   ├── powershell
│   │   │   ├── dangerousCmdlets.ts
│   │   │   ├── parser.ts
│   │   │   └── staticPrefix.ts
│   │   ├── processUserInput
│   │   │   ├── processBashCommand.tsx
│   │   │   ├── processSlashCommand.tsx
│   │   │   ├── processTextPrompt.ts
│   │   │   └── processUserInput.ts
│   │   ├── sandbox
│   │   │   ├── sandbox-adapter.ts
│   │   │   └── sandbox-ui-utils.ts
│   │   ├── secureStorage
│   │   │   ├── fallbackStorage.ts
│   │   │   ├── index.ts
│   │   │   ├── keychainPrefetch.ts
│   │   │   ├── macOsKeychainHelpers.ts
│   │   │   ├── macOsKeychainStorage.ts
│   │   │   └── plainTextStorage.ts
│   │   ├── settings
│   │   │   ├── mdm
│   │   │   │   ├── constants.ts
│   │   │   │   ├── rawRead.ts
│   │   │   │   └── settings.ts
│   │   │   ├── allErrors.ts
│   │   │   ├── applySettingsChange.ts
│   │   │   ├── changeDetector.ts
│   │   │   ├── constants.ts
│   │   │   ├── internalWrites.ts
│   │   │   ├── managedPath.ts
│   │   │   ├── permissionValidation.ts
│   │   │   ├── pluginOnlyPolicy.ts
│   │   │   ├── schemaOutput.ts
│   │   │   ├── settings.ts
│   │   │   ├── settingsCache.ts
│   │   │   ├── toolValidationConfig.ts
│   │   │   ├── types.ts
│   │   │   ├── validateEditTool.ts
│   │   │   ├── validation.ts
│   │   │   └── validationTips.ts
│   │   ├── shell
│   │   │   ├── bashProvider.ts
│   │   │   ├── outputLimits.ts
│   │   │   ├── powershellDetection.ts
│   │   │   ├── powershellProvider.ts
│   │   │   ├── prefix.ts
│   │   │   ├── readOnlyCommandValidation.ts
│   │   │   ├── resolveDefaultShell.ts
│   │   │   ├── shellProvider.ts
│   │   │   ├── shellToolUtils.ts
│   │   │   └── specPrefix.ts
│   │   ├── skills
│   │   │   └── skillChangeDetector.ts
│   │   ├── suggestions
│   │   │   ├── commandSuggestions.ts
│   │   │   ├── directoryCompletion.ts
│   │   │   ├── shellHistoryCompletion.ts
│   │   │   ├── skillUsageTracking.ts
│   │   │   └── slackChannelSuggestions.ts
│   │   ├── swarm
│   │   │   ├── backends
│   │   │   │   ├── detection.ts
│   │   │   │   ├── InProcessBackend.ts
│   │   │   │   ├── it2Setup.ts
│   │   │   │   ├── ITermBackend.ts
│   │   │   │   ├── PaneBackendExecutor.ts
│   │   │   │   ├── registry.ts
│   │   │   │   ├── teammateModeSnapshot.ts
│   │   │   │   ├── TmuxBackend.ts
│   │   │   │   └── types.ts
│   │   │   ├── constants.ts
│   │   │   ├── inProcessRunner.ts
│   │   │   ├── It2SetupPrompt.tsx
│   │   │   ├── leaderPermissionBridge.ts
│   │   │   ├── permissionSync.ts
│   │   │   ├── reconnection.ts
│   │   │   ├── spawnInProcess.ts
│   │   │   ├── spawnUtils.ts
│   │   │   ├── teamHelpers.ts
│   │   │   ├── teammateInit.ts
│   │   │   ├── teammateLayoutManager.ts
│   │   │   ├── teammateModel.ts
│   │   │   └── teammatePromptAddendum.ts
│   │   ├── task
│   │   │   ├── diskOutput.ts
│   │   │   ├── framework.ts
│   │   │   ├── outputFormatting.ts
│   │   │   ├── sdkProgress.ts
│   │   │   └── TaskOutput.ts
│   │   ├── telemetry
│   │   │   ├── betaSessionTracing.ts
│   │   │   ├── bigqueryExporter.ts
│   │   │   ├── events.ts
│   │   │   ├── instrumentation.ts
│   │   │   ├── logger.ts
│   │   │   ├── perfettoTracing.ts
│   │   │   ├── pluginTelemetry.ts
│   │   │   ├── sessionTracing.ts
│   │   │   └── skillLoadedEvent.ts
│   │   ├── teleport
│   │   │   ├── api.ts
│   │   │   ├── environments.ts
│   │   │   ├── environmentSelection.ts
│   │   │   └── gitBundle.ts
│   │   ├── todo
│   │   │   └── types.ts
│   │   ├── ultraplan
│   │   │   ├── ccrSession.ts
│   │   │   └── keyword.ts
│   │   ├── abortController.ts
│   │   ├── activityManager.ts
│   │   ├── advisor.ts
│   │   ├── agentContext.ts
│   │   ├── agenticSessionSearch.ts
│   │   ├── agentId.ts
│   │   ├── agentSwarmsEnabled.ts
│   │   ├── analyzeContext.ts
│   │   ├── ansiToPng.ts
│   │   ├── ansiToSvg.ts
│   │   ├── api.ts
│   │   ├── apiPreconnect.ts
│   │   ├── appleTerminalBackup.ts
│   │   ├── argumentSubstitution.ts
│   │   ├── array.ts
│   │   ├── asciicast.ts
│   │   ├── attachments.ts
│   │   ├── attribution.ts
│   │   ├── auth.ts
│   │   ├── authFileDescriptor.ts
│   │   ├── authPortable.ts
│   │   ├── autoModeDenials.ts
│   │   ├── autoRunIssue.tsx
│   │   ├── autoUpdater.ts
│   │   ├── aws.ts
│   │   ├── awsAuthStatusManager.ts
│   │   ├── backgroundHousekeeping.ts
│   │   ├── betas.ts
│   │   ├── billing.ts
│   │   ├── binaryCheck.ts
│   │   ├── browser.ts
│   │   ├── bufferedWriter.ts
│   │   ├── bundledMode.ts
│   │   ├── caCerts.ts
│   │   ├── caCertsConfig.ts
│   │   ├── cachePaths.ts
│   │   ├── CircularBuffer.ts
│   │   ├── classifierApprovals.ts
│   │   ├── classifierApprovalsHook.ts
│   │   ├── claudeCodeHints.ts
│   │   ├── claudeDesktop.ts
│   │   ├── claudemd.ts
│   │   ├── cleanup.ts
│   │   ├── cleanupRegistry.ts
│   │   ├── cliArgs.ts
│   │   ├── cliHighlight.ts
│   │   ├── codeIndexing.ts
│   │   ├── collapseBackgroundBashNotifications.ts
│   │   ├── collapseHookSummaries.ts
│   │   ├── collapseReadSearch.ts
│   │   ├── collapseTeammateShutdowns.ts
│   │   ├── combinedAbortSignal.ts
│   │   ├── commandLifecycle.ts
│   │   ├── commitAttribution.ts
│   │   ├── completionCache.ts
│   │   ├── concurrentSessions.ts
│   │   ├── config.ts
│   │   ├── configConstants.ts
│   │   ├── contentArray.ts
│   │   ├── context.ts
│   │   ├── contextAnalysis.ts
│   │   ├── contextSuggestions.ts
│   │   ├── controlMessageCompat.ts
│   │   ├── conversationRecovery.ts
│   │   ├── cron.ts
│   │   ├── cronJitterConfig.ts
│   │   ├── cronScheduler.ts
│   │   ├── cronTasks.ts
│   │   ├── cronTasksLock.ts
│   │   ├── crossProjectResume.ts
│   │   ├── crypto.ts
│   │   ├── Cursor.ts
│   │   ├── cwd.ts
│   │   ├── debug.ts
│   │   ├── debugFilter.ts
│   │   ├── desktopDeepLink.ts
│   │   ├── detectRepository.ts
│   │   ├── diagLogs.ts
│   │   ├── diff.ts
│   │   ├── directMemberMessage.ts
│   │   ├── displayTags.ts
│   │   ├── doctorContextWarnings.ts
│   │   ├── doctorDiagnostic.ts
│   │   ├── earlyInput.ts
│   │   ├── editor.ts
│   │   ├── effort.ts
│   │   ├── embeddedTools.ts
│   │   ├── env.ts
│   │   ├── envDynamic.ts
│   │   ├── envUtils.ts
│   │   ├── envValidation.ts
│   │   ├── errorLogSink.ts
│   │   ├── errors.ts
│   │   ├── exampleCommands.ts
│   │   ├── execFileNoThrow.ts
│   │   ├── execFileNoThrowPortable.ts
│   │   ├── execSyncWrapper.ts
│   │   ├── exportRenderer.tsx
│   │   ├── extraUsage.ts
│   │   ├── fastMode.ts
│   │   ├── file.ts
│   │   ├── fileHistory.ts
│   │   ├── fileOperationAnalytics.ts
│   │   ├── fileRead.ts
│   │   ├── fileReadCache.ts
│   │   ├── fileStateCache.ts
│   │   ├── findExecutable.ts
│   │   ├── fingerprint.ts
│   │   ├── forkedAgent.ts
│   │   ├── format.ts
│   │   ├── formatBriefTimestamp.ts
│   │   ├── fpsTracker.ts
│   │   ├── frontmatterParser.ts
│   │   ├── fsOperations.ts
│   │   ├── fullscreen.ts
│   │   ├── generatedFiles.ts
│   │   ├── generators.ts
│   │   ├── genericProcessUtils.ts
│   │   ├── getWorktreePaths.ts
│   │   ├── getWorktreePathsPortable.ts
│   │   ├── ghPrStatus.ts
│   │   ├── git.ts
│   │   ├── gitDiff.ts
│   │   ├── githubRepoPathMapping.ts
│   │   ├── gitSettings.ts
│   │   ├── glob.ts
│   │   ├── gracefulShutdown.ts
│   │   ├── groupToolUses.ts
│   │   ├── handlePromptSubmit.ts
│   │   ├── hash.ts
│   │   ├── headlessProfiler.ts
│   │   ├── heapDumpService.ts
│   │   ├── heatmap.ts
│   │   ├── highlightMatch.tsx
│   │   ├── hooks.ts
│   │   ├── horizontalScroll.ts
│   │   ├── http.ts
│   │   ├── hyperlink.ts
│   │   ├── ide.ts
│   │   ├── idePathConversion.ts
│   │   ├── idleTimeout.ts
│   │   ├── imagePaste.ts
│   │   ├── imageResizer.ts
│   │   ├── imageStore.ts
│   │   ├── imageValidation.ts
│   │   ├── immediateCommand.ts
│   │   ├── ink.ts
│   │   ├── inProcessTeammateHelpers.ts
│   │   ├── intl.ts
│   │   ├── iTermBackup.ts
│   │   ├── jetbrains.ts
│   │   ├── json.ts
│   │   ├── jsonRead.ts
│   │   ├── keyboardShortcuts.ts
│   │   ├── lazySchema.ts
│   │   ├── listSessionsImpl.ts
│   │   ├── localInstaller.ts
│   │   ├── lockfile.ts
│   │   ├── log.ts
│   │   ├── logoV2Utils.ts
│   │   ├── mailbox.ts
│   │   ├── managedEnv.ts
│   │   ├── managedEnvConstants.ts
│   │   ├── markdown.ts
│   │   ├── markdownConfigLoader.ts
│   │   ├── mcpInstructionsDelta.ts
│   │   ├── mcpOutputStorage.ts
│   │   ├── mcpValidation.ts
│   │   ├── mcpWebSocketTransport.ts
│   │   ├── memoize.ts
│   │   ├── memoryFileDetection.ts
│   │   ├── messagePredicates.ts
│   │   ├── messageQueueManager.ts
│   │   ├── messages.ts
│   │   ├── modelCost.ts
│   │   ├── modifiers.ts
│   │   ├── mtls.ts
│   │   ├── notebook.ts
│   │   ├── objectGroupBy.ts
│   │   ├── pasteStore.ts
│   │   ├── path.ts
│   │   ├── pdf.ts
│   │   ├── pdfUtils.ts
│   │   ├── peerAddress.ts
│   │   ├── planModeV2.ts
│   │   ├── plans.ts
│   │   ├── platform.ts
│   │   ├── preflightChecks.tsx
│   │   ├── privacyLevel.ts
│   │   ├── process.ts
│   │   ├── profilerBase.ts
│   │   ├── promptCategory.ts
│   │   ├── promptEditor.ts
│   │   ├── promptShellExecution.ts
│   │   ├── proxy.ts
│   │   ├── queryContext.ts
│   │   ├── QueryGuard.ts
│   │   ├── queryHelpers.ts
│   │   ├── queryProfiler.ts
│   │   ├── queueProcessor.ts
│   │   ├── readEditContext.ts
│   │   ├── readFileInRange.ts
│   │   ├── releaseNotes.ts
│   │   ├── renderOptions.ts
│   │   ├── ripgrep.ts
│   │   ├── sanitization.ts
│   │   ├── screenshotClipboard.ts
│   │   ├── sdkEventQueue.ts
│   │   ├── semanticBoolean.ts
│   │   ├── semanticNumber.ts
│   │   ├── semver.ts
│   │   ├── sequential.ts
│   │   ├── sessionActivity.ts
│   │   ├── sessionEnvironment.ts
│   │   ├── sessionEnvVars.ts
│   │   ├── sessionFileAccessHooks.ts
│   │   ├── sessionIngressAuth.ts
│   │   ├── sessionRestore.ts
│   │   ├── sessionStart.ts
│   │   ├── sessionState.ts
│   │   ├── sessionStorage.ts
│   │   ├── sessionStoragePortable.ts
│   │   ├── sessionTitle.ts
│   │   ├── sessionUrl.ts
│   │   ├── set.ts
│   │   ├── Shell.ts
│   │   ├── ShellCommand.ts
│   │   ├── shellConfig.ts
│   │   ├── sideQuery.ts
│   │   ├── sideQuestion.ts
│   │   ├── signal.ts
│   │   ├── sinks.ts
│   │   ├── slashCommandParsing.ts
│   │   ├── sleep.ts
│   │   ├── sliceAnsi.ts
│   │   ├── slowOperations.ts
│   │   ├── standaloneAgent.ts
│   │   ├── startupProfiler.ts
│   │   ├── staticRender.tsx
│   │   ├── stats.ts
│   │   ├── statsCache.ts
│   │   ├── status.tsx
│   │   ├── statusNoticeDefinitions.tsx
│   │   ├── statusNoticeHelpers.ts
│   │   ├── stream.ts
│   │   ├── streamJsonStdoutGuard.ts
│   │   ├── streamlinedTransform.ts
│   │   ├── stringUtils.ts
│   │   ├── subprocessEnv.ts
│   │   ├── systemDirectories.ts
│   │   ├── systemPrompt.ts
│   │   ├── systemPromptType.ts
│   │   ├── systemTheme.ts
│   │   ├── taggedId.ts
│   │   ├── tasks.ts
│   │   ├── teamDiscovery.ts
│   │   ├── teammate.ts
│   │   ├── teammateContext.ts
│   │   ├── teammateMailbox.ts
│   │   ├── teamMemoryOps.ts
│   │   ├── telemetryAttributes.ts
│   │   ├── teleport.tsx
│   │   ├── tempfile.ts
│   │   ├── terminal.ts
│   │   ├── terminalPanel.ts
│   │   ├── textHighlighting.ts
│   │   ├── theme.ts
│   │   ├── thinking.ts
│   │   ├── timeouts.ts
│   │   ├── tmuxSocket.ts
│   │   ├── tokenBudget.ts
│   │   ├── tokens.ts
│   │   ├── toolErrors.ts
│   │   ├── toolPool.ts
│   │   ├── toolResultStorage.ts
│   │   ├── toolSchemaCache.ts
│   │   ├── toolSearch.ts
│   │   ├── transcriptSearch.ts
│   │   ├── treeify.ts
│   │   ├── truncate.ts
│   │   ├── unaryLogging.ts
│   │   ├── undercover.ts
│   │   ├── user.ts
│   │   ├── userAgent.ts
│   │   ├── userPromptKeywords.ts
│   │   ├── uuid.ts
│   │   ├── warningHandler.ts
│   │   ├── which.ts
│   │   ├── windowsPaths.ts
│   │   ├── withResolvers.ts
│   │   ├── words.ts
│   │   ├── workloadContext.ts
│   │   ├── worktree.ts
│   │   ├── worktreeModeEnabled.ts
│   │   ├── xdg.ts
│   │   ├── xml.ts
│   │   ├── yaml.ts
│   │   └── zodToJsonSchema.ts
│   ├── vim
│   │   ├── motions.ts
│   │   ├── operators.ts
│   │   ├── textObjects.ts
│   │   ├── transitions.ts
│   │   └── types.ts
│   ├── voice
│   │   └── voiceModeEnabled.ts
│   ├── commands.ts
│   ├── context.ts
│   ├── cost-tracker.ts
│   ├── costHook.ts
│   ├── dialogLaunchers.tsx
│   ├── history.ts
│   ├── ink.ts
│   ├── interactiveHelpers.tsx
│   ├── main.tsx
│   ├── projectOnboardingState.ts
│   ├── query.ts
│   ├── QueryEngine.ts
│   ├── replLauncher.tsx
│   ├── setup.ts
│   ├── Task.ts
│   ├── tasks.ts
│   ├── Tool.ts
│   └── tools.ts
├── vendor
│   ├── audio-capture-src
│   │   └── index.ts
│   ├── image-processor-src
│   │   └── index.ts
│   ├── modifiers-napi-src
│   │   └── index.ts
│   └── url-handler-src
│       └── index.ts
├── .gitignore
├── package-lock.json
├── package.json
├── README.md
└── README.zh-CN.md
```
