// Schema metadata only: never query task objectives, messages or credential values.
const REQUIRED = {
  tasks: ['id', 'task_id', 'tenant_id', 'user_id', 'requested_by', 'repository', 'branch', 'mode', 'objective', 'merge_policy', 'github_run_id', 'conversation_id', 'execution_provider', 'correlation_id', 'created_at'],
  conversations: ['id', 'tenant_id', 'requested_by', 'title', 'repository', 'branch', 'created_at', 'updated_at', 'archived_at'],
  conversation_messages: ['id', 'conversation_id', 'requested_by', 'role', 'content', 'attachments_json', 'created_at'],
  run_events: ['id', 'conversation_id', 'task_id', 'requested_by', 'kind', 'label', 'detail', 'created_at'],
};

export async function taskStorageReadiness(d1) {
  try {
    const missing = [];
    for (const [table, columns] of Object.entries(REQUIRED)) {
      // table comes only from the fixed manifest above.
      const result = await d1.prepare(`PRAGMA table_info(${table})`).all();
      const present = new Set((result.results ?? []).map(column => column.name));
      missing.push(...columns.filter(column => !present.has(column)).map(column => `${table}.${column}`));
    }
    return missing.length ? {
      ready: false, code: 'TASK_STORAGE_SCHEMA_MISSING', missing,
      message: `Task history schema is incomplete: ${missing.join(', ')}. Apply the missing database migrations before starting a task.`,
    } : { ready: true, missing: [] };
  } catch {
    return { ready: false, code: 'TASK_STORAGE_UNAVAILABLE', missing: [], message: 'Task history storage is temporarily unavailable. Try again when database access is restored.' };
  }
}
