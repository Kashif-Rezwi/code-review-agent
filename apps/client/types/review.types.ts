import { XCircle, Shield, Zap, Wrench, Lightbulb } from 'lucide-react'

export interface ReviewIssue {
    type: 'bug' | 'security' | 'performance' | 'style' | 'suggestion'
    severity: 'critical' | 'warning' | 'info'
    title: string
    location: string
    description: string
    recommendation: string
}

export interface ReviewData {
    summary: string
    score: number
    issues: ReviewIssue[]
    positives: string[]
}

export const LANGUAGE_LABELS: Record<string, string> = {
    typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python',
    java: 'Java', go: 'Go', rust: 'Rust', html: 'HTML', css: 'CSS',
    sql: 'SQL', json: 'JSON', shell: 'Shell', plaintext: 'Plain Text',
}

export const TYPE_CONFIG = {
    bug: { icon: XCircle, label: 'Bug', color: 'text-red-400', bg: 'bg-red-950/40 border-red-800/50' },
    security: { icon: Shield, label: 'Security', color: 'text-orange-400', bg: 'bg-orange-950/40 border-orange-800/50' },
    performance: { icon: Zap, label: 'Performance', color: 'text-yellow-400', bg: 'bg-yellow-950/40 border-yellow-800/50' },
    style: { icon: Wrench, label: 'Style', color: 'text-blue-400', bg: 'bg-blue-950/40 border-blue-800/50' },
    suggestion: { icon: Lightbulb, label: 'Suggestion', color: 'text-purple-400', bg: 'bg-purple-950/40 border-purple-800/50' },
}

export const SEVERITY_CONFIG = {
    critical: { label: 'Critical', badge: 'bg-red-900/60 text-red-300 border-red-700/60' },
    warning: { label: 'Warning', badge: 'bg-yellow-900/60 text-yellow-300 border-yellow-700/60' },
    info: { label: 'Info', badge: 'bg-gray-800 text-gray-400 border-gray-700' },
}
