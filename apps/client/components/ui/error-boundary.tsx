'use client'

import React from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

interface Props {
    onReset: () => void
    children: React.ReactNode
}

interface State {
    hasError: boolean
}

/**
 * Class-based error boundary for the review output area — catches render errors from
 * ReviewPanel or children and shows a recovery card instead of a blank or broken page.
 */
export class ReviewErrorBoundary extends React.Component<Props, State> {
    state: State = { hasError: false }

    static getDerivedStateFromError(): State {
        return { hasError: true }
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error('[ReviewErrorBoundary]', error, info.componentStack)
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="flex items-start gap-3 bg-red-950/50 border border-red-800 rounded-lg p-4">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
                    <div className="flex-1">
                        <p className="text-sm text-red-300">Something went wrong rendering the review.</p>
                        <button
                            onClick={() => { this.setState({ hasError: false }); this.props.onReset() }}
                            className="mt-2 flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors"
                        >
                            <RotateCcw className="w-3 h-3" /> Try again
                        </button>
                    </div>
                </div>
            )
        }
        return this.props.children
    }
}
