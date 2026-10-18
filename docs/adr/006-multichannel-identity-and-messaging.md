# ADR-006 — Multichannel Messaging, Identity Binding and Safe Approvals

**Status:** Accepted; implementation pending
**Date:** 2026-10-17
**Depends on:** ADR-001–005

## Decision

Praeco exposes one tenant-bound financial teammate over multiple channels; **a channel is a transport, not an authority, account, Assignment or financial ledger**. Vercel Chat SDK is the preferred integration layer for supported channels, with direct provider adapters allowed if a requested channel is unsupported or blocked by provider access. P0 requires Web + Email; Telegram is optional after identity linking. Slack and WhatsApp are planned integrations, not prerequisites to pass financial acceptance. Channel callbacks authenticate, normalize and enqueue work; they never host a competing financial agent loop.

- Web: authenticated first-party application and inspector.
- Email: verified inbound webhook/transport integration (Chat SDK adapter where supported), synthetic attachment ingestion, signed/replay-protected provider events. Sender email is **not** verified vendor or FinanceAdmin authority.
- Telegram: bot inbound adapter; provider account ID is mapped to a tenant through explicit linking. A /start message does not grant financial permissions.
- Slack: install bound to a known workspace and tenant; Slack user ID mapped through enterprise authentication before protected actions.
- WhatsApp: opt-in business API channel with verified webhook and account mapping; provider access, templates and deployment dependencies may defer rollout.
- Where applicable, Chat SDK handles threads/messages/cards. Provider messaging state is independent from the canonical PayableCase and Assignment DB.

## Identity and anti-confusion

Persist `ChannelConnection(tenantId, provider, installationId, status)`, `ExternalPrincipalBinding(tenantId, provider, installationId, providerUserId, authenticatedPrincipalId, bindingRevision, assurance, linkedAt, revokedAt)`, and `ChannelMessageReceipt(tenantId, provider, installationId, eventId, payloadDigest, threadId, messageId, receivedAt)` under matching composite keys. Conversation links, SDK state namespaces and recipient lookups use the same tenant/provider/installation scope. Equal event/user/thread IDs in two installations never select the same binding or suppress a legitimate event. Resolve installation ownership from verified provider context before selecting tenant; reject mismatched payload reuse. Never link accounts by display name, phone, email or message text.

A trusted, authenticated web session may issue a **single-use, short-lived linking challenge** to establish a channel identity. The challenge binds tenant, user, channel installation, external account and expiry; validate it server-side, prevent cross-tenant reuse, audit unlink/revocation. Unlinked senders may receive limited onboarding or submit untrusted documents if permitted, but **cannot** invoke protected financial commands or see private decision details.

Verify provider webhook signatures using the raw original request body (when provider supports signatures), timestamp/replay defenses and install/channel binding before persisting business events. Do not embed app keys or personal payment data in prompts or Chat SDK events.

## Channel commands and financial HITL

- Incoming messages can create or query an Assignment only within the authenticated/linked principal's permitted tenant/capabilities. An LLM may draft proposals; trusted backend routes and validates tool calls.
- The same `PayableCase` can have many `ConversationLink` records; a message's thread ID is not the case's authority or duplicate key.
- A message saying "approve", an emoji reaction, an email reply, or a Chat SDK button **must not** directly consume L2 approvals. They can request an authenticated approval handoff; a FinanceAdmin web action resolves a bound L2 approval request and L2 must re-evaluate all financial gates.
- Before every notification send, recheck active installation, current recipient binding and read permission; enqueue-time permission is insufficient after revocation. Private linked destinations may receive a redacted summary and signed short-lived **navigation** link; links are not authorization capabilities and private evidence stays behind tenant authentication. Unverified/shared destinations receive only generic acknowledgment and an authenticated navigation path, not invoice details.
- P0 may supply an explicitly simulated Blinka payment preview for `AUTHORIZED_SIMULATED`; never send "payment completed" from a chat response.

## Delivery semantics

Provider events may be duplicated, reordered or delayed. Channel receivers durably record tenant/provider/installation/event and normalized payload digest before acknowledging accepted work; transient persistence failure must be retryable. A transactional outbox delivers domain commands and notifications without becoming another workflow engine. Rendering is best effort and never rolls back L2 decisions. Outbound domain deduplication uses tenant/event/installation/recipient/channel and aggregate version, with permission checks on every retry. Provider send idempotency must be demonstrated per adapter: a timeout after successful send can produce duplicate redacted notifications when the provider cannot deduplicate. Record delivery uncertainty and never claim exactly-once messaging or re-execute finance to repair a notification. Provider message IDs are correlation refs, not payable duplicate keys.

## Abuse cases and acceptance

1. Telegram ID from tenant B cannot access tenant A's PayableCase through a known case URL.
2. Forged/stale provider webhook is rejected before command execution.
3. Replayed email creates at most one intake command and never a duplicate L2 financial commitment.
4. Sender email matching a vendor's name or CFO address does not bestow their identity.
5. Cross-channel user linking requires authenticated one-time challenge, and revocation takes effect at next action.
6. A finance-approval message/card without authenticated L2 FinanceAdmin action never commits budget.
7. Out-of-order channel completion message cannot reopen terminal Assignment.
8. Outbound failure or missing WhatsApp credentials does not corrupt Assignment, L1 or L2 state.
9. Same-tenant installations with colliding event/user/thread IDs remain distinct; changed payload reuse is rejected.
10. Revocation between enqueue/send blocks private details; delayed/duplicate notifications cannot reopen resolved financial work.

## Non-goals

No requirement that Slack, WhatsApp and Link Agent Wallet all work by hackathon deadline. No real financial transfers, no purchasing by jurors, no broad general-purpose personal assistant, no automatic channel account merges.

**This ADR must be ratified by review/merge, not by a model-generated acknowledgment.**
