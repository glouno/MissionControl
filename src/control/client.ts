import type {
  Claim,
  BackendConfig,
  Goal,
  GoalInput,
  Task,
  QuestionInput,
  TaskState,
  OwnerOperationInput,
} from "./schema.js";
export class ControlClient {
  constructor(
    readonly url: string,
    readonly token: string,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  async request<T = unknown>(
    path: string,
    method = "GET",
    body?: unknown,
    key?: string,
    timeoutMs = 30000,
  ): Promise<T> {
    const r = await this.fetcher(`${this.url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await r.json()) as any;
    if (!r.ok)
      throw Object.assign(
        new Error(data.error?.message ?? "Control-plane request failed"),
        { code: data.error?.code, status: r.status },
      );
    return data as T;
  }
  createGoal(input: GoalInput, key?: string) {
    return this.request<Goal>("/goals", "POST", input, key);
  }
  switchBackend(
    id: string,
    backend: BackendConfig,
    revision: number,
    key?: string,
  ) {
    return this.request<Goal>(
      `/goals/${id}/backend`,
      "POST",
      { backend, revision },
      key,
    );
  }
  goal(id: string) {
    return this.request<Goal>(`/goals/${id}`);
  }
  tasks(id: string) {
    return this.request<Task[]>(`/goals/${id}/tasks`);
  }
  claim(workerId: string, goalId?: string, key?: string) {
    return this.request<Claim | null>("/claims", "POST", { workerId, goalId }, key);
  }
  heartbeat(c: Claim) {
    return this.request(`/tasks/${c.task.id}/heartbeat`, "POST", {
      workerId: c.workerId,
      generation: c.generation,
    });
  }
  transition(
    c: Claim,
    status: "running" | "verifying" | "integrating",
    result?: unknown,
  ) {
    return this.request(`/tasks/${c.task.id}/transition`, "POST", {
      workerId: c.workerId,
      generation: c.generation,
      status,
      result,
    });
  }
  checkpoint(c: Claim, input: unknown) {
    return this.request(`/tasks/${c.task.id}/checkpoint`, "POST", {
      workerId: c.workerId,
      generation: c.generation,
      checkpoint: input,
    });
  }
  question(c: Claim, input: QuestionInput) {
    return this.request(`/tasks/${c.task.id}/question`, "POST", {
      workerId: c.workerId,
      generation: c.generation,
      request: input,
    });
  }
  operation(c: Claim, input: OwnerOperationInput) {
    return this.request(`/tasks/${c.task.id}/operation`, "POST", {
      workerId: c.workerId,
      generation: c.generation,
      request: input,
    });
  }
  result(c: Claim, result: unknown) {
    return this.request(
      `/tasks/${c.task.id}/result`,
      "POST",
      {
        workerId: c.workerId,
        generation: c.generation,
        result,
      },
      undefined,
      Math.max(30000, c.goal.config.timeoutMs * 3),
    );
  }
  release(
    c: Claim,
    status: Extract<
      TaskState,
      "retry_wait" | "waiting_provider" | "failed" | "blocked"
    >,
    reason: string,
    actualCost?: number,
    usage?: import("./usage.js").Usage,
  ) {
    return this.request(`/tasks/${c.task.id}/release`, "POST", {
      workerId: c.workerId,
      generation: c.generation,
      status,
      reason,
      actualCost,
      usage,
    });
  }
}
