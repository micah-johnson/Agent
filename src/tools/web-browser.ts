/**
 * Web Browser tool - Puppeteer-based headless browser for navigating,
 * screenshotting, clicking, typing, and extracting content from web pages.
 */

import type { Tool, ToolInput, ToolResult } from './types.js';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { mkdirSync, existsSync } from 'fs';

// --- Session management ---

interface BrowserSession {
  browser: Browser;
  page: Page;
  lastUsed: number;
}

const sessions = new Map<string, BrowserSession>();
let sessionCounter = 0;

const MAX_SESSIONS = 3;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SCREENSHOT_DIR = '/tmp/agent-screenshots';
const NAV_TIMEOUT = 30_000;
const ACTION_TIMEOUT = 10_000;
const MAX_CONTENT_LENGTH = 50_000;

/**
 * Close stale sessions that haven't been used in SESSION_TIMEOUT_MS
 */
async function cleanupStaleSessions(): Promise<void> {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > SESSION_TIMEOUT_MS) {
      try {
        await session.browser.close();
      } catch { /* ignore */ }
      sessions.delete(id);
    }
  }
}

/**
 * Get session or return error result
 */
function getSession(sessionId: string): BrowserSession | ToolResult {
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      success: false,
      error: `Session "${sessionId}" not found. Active sessions: ${sessions.size === 0 ? 'none' : Array.from(sessions.keys()).join(', ')}. Use action "launch" to create a new session.`,
    };
  }
  session.lastUsed = Date.now();
  return session;
}

/**
 * List first N clickable elements on the page for error hinting
 */
async function listClickableElements(page: Page, max = 10): Promise<string> {
  try {
    const elements: string[] = await page.evaluate(`
      (() => {
        const selectors = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick]'));
        return selectors.slice(0, ${max}).map(el => {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? '#' + el.id : '';
          const cls = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\\s+/).join('.')
            : '';
          const text = (el.textContent || '').trim().substring(0, 40);
          return '  ' + tag + id + cls + ' — "' + text + '"';
        });
      })()
    `) as string[];
    return elements.length > 0
      ? `\nClickable elements on page:\n${elements.join('\n')}`
      : '\nNo clickable elements found on page.';
  } catch {
    return '';
  }
}

/**
 * Strip HTML to plain text (mirrors web-fetch logic)
 */
function htmlToText(html: string): string {
  // Remove script tags and their contents
  let cleaned = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  // Remove style tags and their contents
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  // Remove all remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  cleaned = cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  // Collapse whitespace
  cleaned = cleaned.replace(/ +/g, ' ');
  cleaned = cleaned.replace(/\n\s*\n\s*\n+/g, '\n\n');
  cleaned = cleaned.split('\n').map(line => line.trim()).join('\n');
  cleaned = cleaned.trim();
  return cleaned;
}

/**
 * Basic HTML-to-markdown conversion preserving links and headers
 */
function htmlToMarkdown(html: string): string {
  // Remove script/style
  let md = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  md = md.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Headers
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');

  // Links: <a href="url">text</a> → [text](url)
  md = md.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // Bold / italic
  md = md.replace(/<(strong|b)\b[^>]*>(.*?)<\/\1>/gi, '**$2**');
  md = md.replace(/<(em|i)\b[^>]*>(.*?)<\/\1>/gi, '*$2*');

  // Line breaks and paragraphs
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<\/p>/gi, '\n\n');
  md = md.replace(/<p[^>]*>/gi, '');

  // Lists
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');

  // Remove remaining tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode entities
  md = md
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");

  // Collapse whitespace
  md = md.replace(/ +/g, ' ');
  md = md.replace(/\n\s*\n\s*\n+/g, '\n\n');
  md = md.split('\n').map(line => line.trim()).join('\n');
  md = md.trim();

  return md;
}

// --- Action handlers ---

async function handleLaunch(input: ToolInput): Promise<ToolResult> {
  if (sessions.size >= MAX_SESSIONS) {
    return {
      success: false,
      error: `Maximum concurrent sessions reached (${MAX_SESSIONS}). Close an existing session first. Active: ${Array.from(sessions.keys()).join(', ')}`,
    };
  }

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    page.setDefaultTimeout(ACTION_TIMEOUT);

    // Set a reasonable viewport
    await page.setViewport({ width: 1280, height: 800 });

    sessionCounter++;
    const sessionId = `browser_${sessionCounter}`;

    sessions.set(sessionId, { browser, page, lastUsed: Date.now() });

    let output = `Browser session "${sessionId}" launched.`;

    // Optionally navigate immediately
    if (input.url) {
      try {
        await page.goto(input.url as string, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        const title = await page.title();
        output += `\nNavigated to: ${input.url}\nPage title: ${title}`;
      } catch (err: any) {
        output += `\nWarning: navigation to ${input.url} failed: ${err.message}`;
      }
    }

    return { success: true, output, metadata: { session_id: sessionId } };
  } catch (err: any) {
    return { success: false, error: `Failed to launch browser: ${err.message}` };
  }
}

async function handleNavigate(input: ToolInput): Promise<ToolResult> {
  const sessionOrError = getSession(input.session_id as string);
  if ('error' in sessionOrError && !('page' in sessionOrError)) return sessionOrError as ToolResult;
  const session = sessionOrError as BrowserSession;

  const url = input.url as string;
  if (!url) return { success: false, error: 'url is required for navigate action' };

  try {
    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    const title = await session.page.title();

    // Get a brief text summary
    let textSummary = '';
    try {
      const bodyText = await session.page.evaluate(`document.body ? document.body.innerText : ''`) as string;
      textSummary = bodyText.substring(0, 2000).trim();
    } catch { /* ignore */ }

    return {
      success: true,
      output: `Navigated to: ${url}\nPage title: ${title}\n\nContent preview:\n${textSummary}`,
      metadata: { title, url: session.page.url() },
    };
  } catch (err: any) {
    return { success: false, error: `Navigation failed: ${err.message}` };
  }
}

async function handleScreenshot(input: ToolInput): Promise<ToolResult> {
  const sessionOrError = getSession(input.session_id as string);
  if ('error' in sessionOrError && !('page' in sessionOrError)) return sessionOrError as ToolResult;
  const session = sessionOrError as BrowserSession;

  // Ensure screenshot directory exists
  if (!existsSync(SCREENSHOT_DIR)) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = `${SCREENSHOT_DIR}/screenshot-${timestamp}.png`;
  const fullPage = input.full_page === true;
  const selector = input.selector as string | undefined;

  try {
    if (selector) {
      const element = await session.page.$(selector);
      if (!element) {
        const hint = await listClickableElements(session.page);
        return { success: false, error: `Selector "${selector}" not found.${hint}` };
      }
      await element.screenshot({ path: filePath });
    } else {
      await session.page.screenshot({ path: filePath, fullPage });
    }

    return {
      success: true,
      output: `Screenshot saved to: ${filePath}`,
      metadata: { file_path: filePath, full_page: fullPage, selector },
    };
  } catch (err: any) {
    return { success: false, error: `Screenshot failed: ${err.message}` };
  }
}

async function handleClick(input: ToolInput): Promise<ToolResult> {
  const sessionOrError = getSession(input.session_id as string);
  if ('error' in sessionOrError && !('page' in sessionOrError)) return sessionOrError as ToolResult;
  const session = sessionOrError as BrowserSession;

  const selector = input.selector as string;
  if (!selector) return { success: false, error: 'selector is required for click action' };

  try {
    const element = await session.page.$(selector);
    if (!element) {
      const hint = await listClickableElements(session.page);
      return { success: false, error: `Selector "${selector}" not found.${hint}` };
    }
    await element.click();
    // Small wait for any resulting navigation or DOM changes
    await new Promise(r => setTimeout(r, 500));

    const title = await session.page.title();
    return {
      success: true,
      output: `Clicked: ${selector}\nCurrent page title: ${title}\nCurrent URL: ${session.page.url()}`,
    };
  } catch (err: any) {
    const hint = await listClickableElements(session.page);
    return { success: false, error: `Click failed on "${selector}": ${err.message}${hint}` };
  }
}

async function handleType(input: ToolInput): Promise<ToolResult> {
  const sessionOrError = getSession(input.session_id as string);
  if ('error' in sessionOrError && !('page' in sessionOrError)) return sessionOrError as ToolResult;
  const session = sessionOrError as BrowserSession;

  const selector = input.selector as string;
  const text = input.text as string;
  if (!selector) return { success: false, error: 'selector is required for type action' };
  if (text === undefined || text === null) return { success: false, error: 'text is required for type action' };

  try {
    const element = await session.page.$(selector);
    if (!element) {
      const hint = await listClickableElements(session.page);
      return { success: false, error: `Selector "${selector}" not found.${hint}` };
    }
    await element.click({ clickCount: 3 }); // Select all existing text
    await element.type(text);

    return {
      success: true,
      output: `Typed "${text.length > 100 ? text.substring(0, 100) + '...' : text}" into ${selector}`,
    };
  } catch (err: any) {
    return { success: false, error: `Type failed on "${selector}": ${err.message}` };
  }
}

async function handleEvaluate(input: ToolInput): Promise<ToolResult> {
  const sessionOrError = getSession(input.session_id as string);
  if ('error' in sessionOrError && !('page' in sessionOrError)) return sessionOrError as ToolResult;
  const session = sessionOrError as BrowserSession;

  const script = input.script as string;
  if (!script) return { success: false, error: 'script is required for evaluate action' };

  try {
    const result = await session.page.evaluate(script);
    const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return {
      success: true,
      output: output ?? '(undefined)',
      metadata: { type: typeof result },
    };
  } catch (err: any) {
    return { success: false, error: `Evaluate failed: ${err.message}` };
  }
}

async function handleContent(input: ToolInput): Promise<ToolResult> {
  const sessionOrError = getSession(input.session_id as string);
  if ('error' in sessionOrError && !('page' in sessionOrError)) return sessionOrError as ToolResult;
  const session = sessionOrError as BrowserSession;

  const mode = (input.mode as string) || 'text';

  try {
    const rawHtml = await session.page.content();
    let content: string;

    switch (mode) {
      case 'html':
        content = rawHtml;
        break;
      case 'markdown':
        content = htmlToMarkdown(rawHtml);
        break;
      case 'text':
      default:
        content = htmlToText(rawHtml);
        break;
    }

    // Truncate
    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.substring(0, MAX_CONTENT_LENGTH) + '\n\n... (content truncated)';
    }

    return {
      success: true,
      output: content,
      metadata: { mode, length: content.length, url: session.page.url() },
    };
  } catch (err: any) {
    return { success: false, error: `Content extraction failed: ${err.message}` };
  }
}

async function handleScroll(input: ToolInput): Promise<ToolResult> {
  const sessionOrError = getSession(input.session_id as string);
  if ('error' in sessionOrError && !('page' in sessionOrError)) return sessionOrError as ToolResult;
  const session = sessionOrError as BrowserSession;

  const direction = (input.direction as string) || 'down';
  const amount = (input.amount as number) || 500;

  if (direction !== 'up' && direction !== 'down') {
    return { success: false, error: 'direction must be "up" or "down"' };
  }

  try {
    const scrollY = direction === 'down' ? amount : -amount;
    await session.page.evaluate(`window.scrollBy(0, ${scrollY})`);

    const scrollPos = await session.page.evaluate(`
      ({ x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight, viewportHeight: window.innerHeight })
    `) as { x: number; y: number; height: number; viewportHeight: number };

    return {
      success: true,
      output: `Scrolled ${direction} by ${amount}px. Current position: ${scrollPos.y}px / ${scrollPos.height}px (viewport: ${scrollPos.viewportHeight}px)`,
      metadata: scrollPos,
    };
  } catch (err: any) {
    return { success: false, error: `Scroll failed: ${err.message}` };
  }
}

async function handleClose(input: ToolInput): Promise<ToolResult> {
  const sessionId = input.session_id as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      success: false,
      error: `Session "${sessionId}" not found. Active sessions: ${sessions.size === 0 ? 'none' : Array.from(sessions.keys()).join(', ')}`,
    };
  }

  try {
    await session.browser.close();
  } catch { /* ignore */ }
  sessions.delete(sessionId);

  return {
    success: true,
    output: `Session "${sessionId}" closed. Remaining sessions: ${sessions.size === 0 ? 'none' : Array.from(sessions.keys()).join(', ')}`,
  };
}

// --- Tool definition ---

export const webBrowserTool: Tool = {
  name: 'web_browser',
  description: `Launch and control a headless browser (Puppeteer). Useful for pages that need JavaScript rendering, taking screenshots, filling forms, and interacting with web apps.

Actions:
- launch: Start a new browser session. Optional "url" to navigate immediately.
- navigate: Go to a URL. Params: session_id, url.
- screenshot: Capture the page or an element. Params: session_id, selector (optional), full_page (optional).
- click: Click an element. Params: session_id, selector.
- type: Type into an input. Params: session_id, selector, text.
- evaluate: Run JavaScript in the page. Params: session_id, script.
- content: Get page content. Params: session_id, mode ("html"|"text"|"markdown", default "text").
- scroll: Scroll the page. Params: session_id, direction ("up"|"down"), amount (pixels, default 500).
- close: Close a browser session. Params: session_id.`,

  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The browser action to perform',
        enum: ['launch', 'navigate', 'screenshot', 'click', 'type', 'evaluate', 'content', 'scroll', 'close'],
      },
      session_id: {
        type: 'string',
        description: 'Browser session ID (returned by launch). Required for all actions except launch.',
      },
      url: {
        type: 'string',
        description: 'URL to navigate to (for launch and navigate actions)',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for the target element (for click, type, screenshot actions)',
      },
      text: {
        type: 'string',
        description: 'Text to type (for type action)',
      },
      script: {
        type: 'string',
        description: 'JavaScript to evaluate in the page (for evaluate action)',
      },
      mode: {
        type: 'string',
        description: 'Content extraction mode: "html", "text", or "markdown" (for content action, default "text")',
        enum: ['html', 'text', 'markdown'],
      },
      full_page: {
        type: 'boolean',
        description: 'Capture full page screenshot (for screenshot action, default false)',
      },
      direction: {
        type: 'string',
        description: 'Scroll direction (for scroll action)',
        enum: ['up', 'down'],
      },
      amount: {
        type: 'number',
        description: 'Pixels to scroll (for scroll action, default 500)',
      },
    },
    required: ['action'],
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    // Clean up stale sessions before every action
    await cleanupStaleSessions();

    const action = input.action as string;

    switch (action) {
      case 'launch':
        return handleLaunch(input);
      case 'navigate':
        return handleNavigate(input);
      case 'screenshot':
        return handleScreenshot(input);
      case 'click':
        return handleClick(input);
      case 'type':
        return handleType(input);
      case 'evaluate':
        return handleEvaluate(input);
      case 'content':
        return handleContent(input);
      case 'scroll':
        return handleScroll(input);
      case 'close':
        return handleClose(input);
      default:
        return {
          success: false,
          error: `Unknown action "${action}". Valid actions: launch, navigate, screenshot, click, type, evaluate, content, scroll, close`,
        };
    }
  },
};
