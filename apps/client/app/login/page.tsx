'use client'

import { signIn } from 'next-auth/react'

function GitHubIcon() {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            style={{ width: 18, height: 18, flexShrink: 0 }}
        >
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z" />
        </svg>
    )
}

export default function LoginPage() {
    return (
        <main
            style={{
                position: 'relative',
                minHeight: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                backgroundColor: '#090e13',
                fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
            }}
        >

            {/* Content */}
            <div
                style={{
                    position: 'relative',
                    zIndex: 10,
                    width: '100%',
                    maxWidth: 384,
                    padding: '0 24px',
                }}
            >
                {/* Logo */}
                <div style={{ textAlign: 'center', marginBottom: 40 }}>
                    <div style={{ marginBottom: 4 }}>
                        <span
                            style={{
                                fontSize: 36,
                                fontWeight: 800,
                                letterSpacing: '-0.03em',
                                color: '#ffffff',
                                lineHeight: 1.1,
                            }}
                        >
                            Code Review<span style={{ color: '#60a5fa' }}> Agent</span>
                        </span>
                    </div>
                    <p
                        style={{
                            color: '#94a3b8',
                            fontSize: 14,
                            lineHeight: 1.6,
                            maxWidth: 320,
                            margin: '12px auto 0',
                        }}
                    >
                        Instant AI code review. Code paste or PR link. Actionable feedback with your standards.
                    </p>
                </div>

                {/* Glass card — glass + blue glow */}
                <div
                    style={{
                        width: '100%',
                        maxWidth: 360,
                        backgroundColor: 'rgba(255,255,255,0.025)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 16,
                        padding: '28px 28px 24px',
                        textAlign: 'center',
                        boxShadow: '0 0 0 1px rgba(59,130,246,0.1), 0 0 32px rgba(59,130,246,0.12)',
                    }}
                >
                    <p
                        style={{
                            margin: '0 0 20px',
                            fontSize: 13.5,
                            lineHeight: 1.6,
                            color: '#94a3b8',
                        }}
                    >
                        Sign in with GitHub to start reviewing code<br />
                        and track your reviews across sessions.
                    </p>

                    <button
                        id="github-signin-btn"
                        onClick={() => signIn('github', { callbackUrl: '/review' })}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 10,
                            width: '100%',
                            padding: '11px 18px',
                            backgroundColor: '#ffffff',
                            color: '#0f172a',
                            border: 'none',
                            borderRadius: 12,
                            fontSize: 14,
                            fontWeight: 600,
                            letterSpacing: '-0.01em',
                            cursor: 'pointer',
                            transition: 'box-shadow 0.2s ease, transform 0.2s ease',
                            fontFamily: 'inherit',
                        }}
                        onMouseEnter={e => {
                            e.currentTarget.style.boxShadow = 'rgba(9,14,19,0.6) 0px 8px 24px 0px'
                            e.currentTarget.style.transform = 'scale(1.02)'
                        }}
                        onMouseLeave={e => {
                            e.currentTarget.style.boxShadow = 'none'
                            e.currentTarget.style.transform = 'scale(1)'
                        }}
                    >
                        <GitHubIcon />
                        Continue with GitHub
                    </button>
                </div>

                <p style={{ textAlign: 'center', color: '#475569', fontSize: 12, marginTop: 24 }}>
                    Requires{' '}
                    <code
                        style={{
                            color: '#64748b',
                            backgroundColor: 'rgba(30,41,59,0.6)',
                            padding: '2px 6px',
                            borderRadius: 4,
                            fontFamily: 'var(--font-geist-mono), monospace',
                            fontSize: 11,
                        }}
                    >
                        read:user
                    </code>
                    {' '}scope to identify your account.
                </p>
            </div>


        </main>
    )
}
