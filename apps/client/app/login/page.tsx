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
                backgroundColor: '#080810',
                fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
            }}
        >
            {/* Orb 1 — top-left, indigo, 600×600px, opacity 0.3 */}
            <div
                aria-hidden
                style={{
                    position: 'absolute',
                    top: '-20%',
                    left: '-10%',
                    width: 600,
                    height: 600,
                    borderRadius: '50%',
                    opacity: 0.3,
                    background: 'radial-gradient(circle, rgba(99,102,241,0.4) 0%, transparent 70%)',
                    pointerEvents: 'none',
                    animation: 'orbFloat 8s ease-in-out infinite',
                }}
            />

            {/* Orb 2 — bottom-right, purple, 500×500px, opacity 0.2 */}
            <div
                aria-hidden
                style={{
                    position: 'absolute',
                    bottom: '-15%',
                    right: '-5%',
                    width: 500,
                    height: 500,
                    borderRadius: '50%',
                    opacity: 0.2,
                    background: 'radial-gradient(circle, rgba(168,85,247,0.4) 0%, transparent 70%)',
                    pointerEvents: 'none',
                    animation: 'orbFloat 10s ease-in-out infinite reverse',
                }}
            />

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
                            Code Review<span style={{ color: '#818cf8' }}> Agent</span>
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

                {/* Glass card — glass + glow-indigo */}
                <div
                    style={{
                        width: '100%',
                        maxWidth: 360,
                        backgroundColor: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 16,
                        padding: '28px 28px 24px',
                        textAlign: 'center',
                        boxShadow: 'rgba(99,102,241,0.25) 0px 0px 40px 0px',
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
                            e.currentTarget.style.boxShadow = '0 0 20px rgba(99,102,241,0.3)'
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

            <style>{`
                @keyframes orbFloat {
                    0%, 100% { transform: translateY(0px) scale(1); }
                    50% { transform: translateY(-20px) scale(1.05); }
                }
            `}</style>
        </main>
    )
}
