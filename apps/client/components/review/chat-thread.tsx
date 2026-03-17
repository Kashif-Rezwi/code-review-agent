import type { RefObject } from 'react'
import type { ChatMessage } from '@/types/review.types'
import { UserBubble, AssistantMessage, LoadingIndicator } from './chat-message'

interface ChatThreadProps {
    messages: ChatMessage[]
    /** Non-null while the assistant is streaming a response token-by-token. */
    streamingContent: string | null
    isSending: boolean
    /** Scroll anchor sentinel — only required when the parent manages scroll manually. */
    bottomRef?: RefObject<HTMLDivElement | null>
}

/**
 * Renders a full chat conversation: settled messages, the in-progress streaming
 * response (with blinking cursor), and the loading dots while waiting for the
 * first token. Used on both the Review page and the History detail page.
 */
export function ChatThread({ messages, streamingContent, isSending, bottomRef }: ChatThreadProps) {
    return (
        <div className="flex flex-col gap-6 pt-4">
            {messages.map((msg, i) =>
                msg.role === 'user'
                    ? <UserBubble key={i} content={msg.content} />
                    : <AssistantMessage key={i} content={msg.content} />
            )}

            {/* Streaming in-progress assistant message */}
            {streamingContent !== null && (
                <AssistantMessage content={streamingContent} isStreaming={true} />
            )}

            {/* Loading dots — only while waiting for the first token to arrive */}
            {isSending && streamingContent === null && <LoadingIndicator />}

            {bottomRef && <div ref={bottomRef} />}
        </div>
    )
}
