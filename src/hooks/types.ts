/**
 * Lifecycle hooks type definitions.
 *
 * Hooks let you run shell commands at specific points during agent execution.
 * Config lives at $WORKSPACE/config/hooks.json.
 */

export interface HookConfig {
  matcher?: string;      // regex for tool name matching (pre_tool/post_tool only)
  command: string;       // shell command to execute — gets JSON on stdin
  timeout?: number;      // ms before killing process, default 5000
  enabled?: boolean;     // default true
}

export interface HooksConfig {
  hooks: {
    pre_tool?: HookConfig[];
    post_tool?: HookConfig[];
    on_message?: HookConfig[];
    on_response?: HookConfig[];
    on_error?: HookConfig[];
  };
}

export type HookEvent = 'pre_tool' | 'post_tool' | 'on_message' | 'on_response' | 'on_error';

export interface PreToolResult {
  action?: 'allow' | 'deny' | 'modify';
  reason?: string;
  modified_input?: Record<string, any>;
}

export interface PostToolResult {
  context?: string;
  suppress_output?: boolean;
}

export interface MessageHookResult {
  action?: 'allow' | 'block';
  reason?: string;
  context?: string;
}

export interface ResponseHookResult {
  action?: 'accept' | 'continue';
  reason?: string;
}

export interface HookContext {
  channel_id: string;
  user_id: string;
  display_name?: string;
}
