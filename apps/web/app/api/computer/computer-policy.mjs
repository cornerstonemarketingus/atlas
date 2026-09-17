const WORKFLOWS = new Set(["custom", "job-application", "sales-outreach", "marketing"]);

export function normalizeComputerWorkflow(value) {
  return typeof value === "string" && WORKFLOWS.has(value) ? value : "custom";
}

export function computerExecutionPolicy(workflowType) {
  const workflow = normalizeComputerWorkflow(workflowType);
  const alwaysApprove = [
    "submit_form",
    "send_message",
    "publish_content",
    "purchase",
    "upload_sensitive_file",
    "change_account_or_security_settings",
  ];
  if (workflow === "job-application") alwaysApprove.push("submit_job_application");
  if (workflow === "sales-outreach") alwaysApprove.push("send_sales_outreach", "enroll_contact_in_sequence");
  if (workflow === "marketing") alwaysApprove.push("launch_campaign", "change_ad_spend");
  return {
    version: 1,
    workflow,
    defaultDecision: "allow-read-only",
    alwaysApprove,
    prohibited: [
      "bypass_access_or_anti_bot_controls",
      "misrepresent_identity_or_qualifications",
      "send_bulk_unsolicited_messages",
      "hide_sponsorship_or_automation_when_disclosure_is_required",
    ],
    stopOnAmbiguity: true,
  };
}
