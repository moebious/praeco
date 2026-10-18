"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { openWorkspaceConversation, renameWorkspaceConversation } from "@/lib/conversation-service"
import { metadataFailure } from "@/lib/conversations"
import { WorkspaceAccessError } from "@/lib/auth"

function inputFields(formData: FormData) {
  return Object.fromEntries(
    [...formData.entries()].filter(([name]) => !name.startsWith("$ACTION_"))
  )
}

function actionFailure(error: unknown): never {
  if (error instanceof WorkspaceAccessError) {
    redirect(error.status === 401 ? "/sign-in" : "/auth/setup")
  }
  redirect(`/?workspaceError=${metadataFailure(error).code}`)
}

export async function openSpecialistConversation(formData: FormData): Promise<void> {
  let id: string
  try {
    id = await openWorkspaceConversation(inputFields(formData))
  } catch (error) {
    actionFailure(error)
  }
  revalidatePath("/", "layout")
  redirect(`/chats/${id}`)
}

export async function renameConversation(formData: FormData): Promise<void> {
  let id: string
  try {
    id = await renameWorkspaceConversation(inputFields(formData))
  } catch (error) {
    actionFailure(error)
  }
  revalidatePath("/", "layout")
  redirect(`/chats/${id}`)
}
