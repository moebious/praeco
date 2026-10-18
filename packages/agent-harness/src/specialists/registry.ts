import { HarnessError } from '../state-machine.js';
import type { SpecialistRole, TrustedExecutionContext } from '../types.js';
import type { SpecialistToolDefinition } from './types.js';

export class SpecialistToolRegistry {
  private readonly tools = new Map<string, SpecialistToolDefinition<any, any>>();

  registerTool<TParams, TResult>(tool: SpecialistToolDefinition<TParams, TResult>): void {
    if (this.tools.has(tool.name)) {
      throw new HarnessError('DUPLICATE_TOOL_REGISTRATION', `Tool ${tool.name} is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): SpecialistToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  listToolsForRole(role: SpecialistRole): readonly SpecialistToolDefinition<any, any>[] {
    return Array.from(this.tools.values()).filter((t) => t.allowedRoles.includes(role));
  }

  /**
   * Dispatches execution of a registered tool with strict role-based access control.
   * Model arguments are schema-parsed via Zod; the TrustedExecutionContext is injected
   * by the server, ensuring callers cannot forge tenant, actor, runId or ownership epoch.
   */
  async executeTool(
    name: string,
    role: SpecialistRole,
    rawParams: unknown,
    context: TrustedExecutionContext
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new HarnessError('TOOL_NOT_FOUND', `Specialist tool ${name} is not registered`);
    }

    if (!tool.allowedRoles.includes(role)) {
      throw new HarnessError(
        'UNAUTHORIZED_SPECIALIST_ROLE',
        `Role ${role} is not authorized to invoke specialist tool ${name}. Allowed roles: ${tool.allowedRoles.join(', ')}`
      );
    }

    // Parse and validate parameters
    const parseResult = tool.schema.safeParse(rawParams);
    if (!parseResult.success) {
      throw new HarnessError(
        'INVALID_TOOL_PARAMETERS',
        `Invalid parameters for tool ${name}: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    return tool.execute(parseResult.data, context);
  }
}
