import { WorkflowsPG } from "@mastra/pg";
import { GidorahError } from "../foundation/errors.js";

export class ObservedCheckpointWrites extends WorkflowsPG {
  readonly failureController = new AbortController();
  private failure?: GidorahError;

  assertHealthy(): void {
    if (this.failure) throw this.failure;
  }

  private async write<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.assertHealthy();
    try {
      return await operation();
    } catch {
      this.failure ??= new GidorahError(
        "checkpoint_write_failed",
        "A mandatory native checkpoint write failed. Execution cannot report success.",
      );
      this.failureController.abort();
      throw this.failure;
    }
  }

  override persistWorkflowSnapshot(
    input: Parameters<WorkflowsPG["persistWorkflowSnapshot"]>[0],
  ): ReturnType<WorkflowsPG["persistWorkflowSnapshot"]> {
    return this.write(() => super.persistWorkflowSnapshot(input));
  }

  override updateWorkflowResults(
    input: Parameters<WorkflowsPG["updateWorkflowResults"]>[0],
  ): ReturnType<WorkflowsPG["updateWorkflowResults"]> {
    return this.write(() => super.updateWorkflowResults(input));
  }

  override updateWorkflowState(
    input: Parameters<WorkflowsPG["updateWorkflowState"]>[0],
  ): ReturnType<WorkflowsPG["updateWorkflowState"]> {
    return this.write(() => super.updateWorkflowState(input));
  }
}
