/**
 * Math tool — evaluate mathematical expressions safely
 *
 * Supports arithmetic, exponents, trig, log, abs, min/max, etc.
 * No access to globals or side effects — just pure math.
 */

import type { Tool, ToolInput, ToolResult } from './types.js';

// Whitelist of safe Math functions and constants
const MATH_ENV: Record<string, unknown> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  trunc: Math.trunc,
  sign: Math.sign,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  hypot: Math.hypot,
  random: Math.random,
  PI: Math.PI,
  E: Math.E,
  Infinity,
  NaN,
};

function safeEval(expression: string): number {
  // Block anything that looks like property access, assignment, or function constructors
  if (/[{}[\];]/.test(expression)) {
    throw new Error('Invalid characters in expression');
  }
  if (/\b(import|require|eval|Function|constructor|prototype|__proto__|this|window|global|process)\b/.test(expression)) {
    throw new Error('Forbidden keyword in expression');
  }

  // Build a function with only math bindings in scope
  const paramNames = Object.keys(MATH_ENV);
  const paramValues = Object.values(MATH_ENV);

  // The function body just returns the expression
  const fn = new Function(...paramNames, `"use strict"; return (${expression});`);
  const result = fn(...paramValues);

  if (typeof result !== 'number' && typeof result !== 'bigint') {
    throw new Error(`Expression did not return a number (got ${typeof result})`);
  }

  return Number(result);
}

export const mathTool: Tool = {
  name: 'math',
  description:
    'Evaluate a mathematical expression and return the result. ' +
    'Supports: arithmetic (+, -, *, /, %, **), comparisons, ' +
    'and functions: abs, ceil, floor, round, sqrt, cbrt, pow, min, max, ' +
    'log, log2, log10, exp, sin, cos, tan, asin, acos, atan, atan2, hypot. ' +
    'Constants: PI, E, Infinity. Examples: "1024 * 768", "sqrt(144)", "log2(1048576)", ' +
    '"pow(2, 32)", "min(15, 30) * 0.8 + max(15, 30) * 0.2".',
  input_schema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The mathematical expression to evaluate. Use function-call syntax for math functions (e.g., sqrt(16), not Math.sqrt(16)).',
      },
    },
    required: ['expression'],
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const expression = input.expression as string;
    if (!expression?.trim()) {
      return { success: false, error: 'expression is required' };
    }

    try {
      const result = safeEval(expression.trim());
      return {
        success: true,
        output: `${expression.trim()} = ${result}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Math error: ${msg}` };
    }
  },
};
