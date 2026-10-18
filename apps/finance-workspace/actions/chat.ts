"use server"

import {
  bootstrapOwnedChat, loadOwnedTranscript, mintOwnedChatToken, startOwnedChat,
} from "@/lib/chat/control"

export async function startChatSession(input: unknown) { return startOwnedChat(input) }
export async function mintChatAccessToken(input: unknown) { return mintOwnedChatToken(input) }
export async function loadChatTranscript(input: unknown) { return loadOwnedTranscript(input) }
export async function bootstrapChat(input: unknown) { return bootstrapOwnedChat(input) }
