import { StatusMessage } from './status-message'

/** Red error card — used on every page to surface API / validation failures. */
export function ErrorBanner({ message }: { message: string }) {
    return <StatusMessage variant="error" message={message} />
}
