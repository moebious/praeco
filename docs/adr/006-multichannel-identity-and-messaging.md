# ADR-006 — Multichannel Messaging, Identity Binding and Safe Approvals

**Status:** Proposed for review, not implemented
**Date:** 2026-10-17
**Depends on:** ADR-001–005

## Decision

Praeco exposes one tenant-bound financial teammate over multiple channels; **a channel is a transport, not an authority, account, Assignment or financial ledger**. Vercel Chat SDK is the preferred integration layer for supported channels, with direct provider adapters allowed if a requested channel is unsupported or blocked by provider access. The MVP prioritizes Web + Email + Telegram. Slack and WhatsApp are planned integrations, not prerequisites to pass financial acceptance.

- Web: authenticated first-party application and inspector.
- Email: verified inbound webhook/transport integration (Chat SDK adapter where supported), synthetic attachment ingestion, signed/replay-protected provider events. Sender email is **not** verified vendor or FinanceAdmin authority.
- Telegram: bot inbound adapter; provider account ID is mapped to a tenant through explicit linking. A /start message does not grant financial permissions.
- Slack: install bound to a known workspace and tenant; Slack user ID mapped through enterprise authentication before protected actions.
- WhatsApp: opt-in business API channel with verified webhook and account mapping; provider access, templates and deployment dependencies may defer rollout.
- Where applicable, Chat SDK handles threads/messages/cards. Provider messaging state is independent from the canonical PayableCase and Assignment DB.

## Identity and anti-confusion

Persist `ChannelConnection(tenantId, channel, installationId, status)`, `ExternalPrincipalBinding(tenantId, channel, providerUserId, authenticatedPrincipalId, assurance, linkedAt, revokedAt)`, and `ChannelMessageReceipt(tenantId, channel, eventId, threadId, messageId, receivedAt)` under tenant-aware unique keys. Never link two accounts merely because they share display name, phone, email or message text.

A trusted, authenticated web session may issue a **single-use, short-lived linking challenge** to establish a channel identity. The challenge binds tenant, user, channel installation, external account and expiry; validate it server-side, prevent cross-tenant reuse, audit unlink/revocation. Unlinked senders may receive limited onboarding or submit untrusted documents if permitted, but **cannot** invoke protected financial commands or see private decision details.

Verify provider webhook signatures using the raw original request body (when provider supports signatures), timestamp/replay defenses and install/channel binding before persisting business events. Do not embed app keys or personal payment data in prompts or Chat SDK events.

## Channel commands and financial HITL

- Incoming messages can create or query an Assignment only within the authenticated/linked principal's permitted tenant/capabilities. An LLM may draft proposals; trusted backend routes and validates tool calls.
- The same `PayableCase` can have many `ConversationLink` records; a message's thread ID is not the case's authority or duplicate key.
- A message saying "approve", an emoji reaction, an email reply, or a Chat SDK button **must not** directly consume L2 approvals. They can request an authenticated approval handoff; a FinanceAdmin web action resolves a bound L2 approval request and L2 must re-evaluate all financial gates.
- Notifications show redacted amount, vendor identifier, decision summary and signed short-lived **navigation** link; navigation links are not authorization capabilities. Private evidence, account details and policy must stay behind tenant authentication.
- P0 may supply an explicitly simulated Blinka payment preview for `AUTHORIZED_SIMULATED`; never send "payment completed" from a chat response.

## Delivery semantics

Provider events may be duplicated, reordered or delayed. Channel receivers record deduplicated inbound events and ack promptly; a transactional outbox coordinates domain commands and outbound notifications. Rendering/conversation status is best effort and never rolls back committed L2 financial decisions. Outbound notifications are idempotent by domain event/recipient/channel, with safe retry and redaction. Provider message IDs are correlation refs, not payable business duplicate keys.

## Abuse cases and acceptance

1. Telegram ID from tenant B cannot access tenant A's PayableCase through a known case URL.
2. Forged/stale provider webhook is rejected before command execution.
3. Replayed email creates at most one intake command and never a duplicate L2 financial commitment.
4. Sender email matching a vendor's name or CFO address does not bestow their identity.
5. Cross-channel user linking requires authenticated one-time challenge, and revocation takes effect at next action.
6. A finance-approval message/card without authenticated L2 FinanceAdmin action never commits budget.
7. Out-of-order channel completion message cannot reopen terminal Assignment.
8. Outbound failure or missing WhatsApp credentials does not corrupt Assignment, L1 or L2 state.

## Non-goals

No requirement that Slack, WhatsApp and Link Agent Wallet all work by hackathon deadline. No real financial transfers, no purchasing by jurors, no broad general-purpose personal assistant, no automatic channel account merges.

**This ADR must be ratified by review/merge, not by a model-generated acknowledgment.**
