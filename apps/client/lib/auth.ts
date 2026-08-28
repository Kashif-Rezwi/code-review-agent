import NextAuth, { NextAuthOptions } from 'next-auth'
import GitHubProvider from 'next-auth/providers/github'
import type { JWT } from 'next-auth/jwt'
import type { Session } from 'next-auth'

// Fail-fast: surface mis-configured Vercel env vars at boot instead of opaque ?error=OAuthCallback
function requiredEnv(name: string): string {
    const value = process.env[name]
    if (!value) {
        throw new Error(
            `${name} is not set. Define it in apps/client/.env (local) or Vercel Project Settings -> Environment Variables (Production/Preview) and redeploy without build cache.`,
        )
    }
    return value
}

const githubClientId = requiredEnv('GITHUB_CLIENT_ID')
const githubClientSecret = requiredEnv('GITHUB_CLIENT_SECRET')
const nextAuthSecret = requiredEnv('NEXTAUTH_SECRET')

// NEXTAUTH_URL is required in production; in local dev NextAuth falls back to request headers
if (process.env.NODE_ENV === 'production' && !process.env.NEXTAUTH_URL && !process.env.VERCEL_URL) {
    throw new Error(
        'NEXTAUTH_URL is not set. Set it to https://<your-vercel-domain> in Vercel Production and Preview envs (e.g. https://code-review-agent-client.vercel.app).',
    )
}

export const authOptions: NextAuthOptions = {
    secret: nextAuthSecret,
    providers: [
        GitHubProvider({
            clientId: githubClientId,
            clientSecret: githubClientSecret,
            authorization: {
                params: {
                    // Identity only — PR fetching uses the server's own GITHUB_TOKEN,
                    // so the broad `repo` scope is intentionally NOT requested.
                    scope: 'read:user user:email',
                },
            },
        }),
    ],

    callbacks: {
        // Persist the GitHub OAuth access token into the JWT on first sign-in
        async jwt({ token, account }: { token: JWT; account: { access_token?: string } | null }) {
            if (account?.access_token) {
                token.githubToken = account.access_token
            }
            return token
        },

        // Expose the GitHub token on the client-side session (typed as string | undefined)
        async session({ session, token }: { session: Session; token: JWT }) {
            session.githubToken = token.githubToken
            return session
        },
    },

    pages: {
        signIn: '/login',
    },

    session: {
        strategy: 'jwt',
    },

    // Surface real errors in Vercel Function Logs instead of generic ?error=OAuthCallback
    // NextAuth hides OAuth errors by default; these logs are server-only and never leak secrets
    logger: {
        error(code, metadata) {
            console.error(`[next-auth][error][${code}]`, metadata)
        },
        warn(code) {
            console.warn(`[next-auth][warn][${code}]`)
        },
        debug(code, metadata) {
            if (process.env.NODE_ENV !== 'production') {
                console.debug(`[next-auth][debug][${code}]`, metadata)
            }
        },
    },
    debug: process.env.NODE_ENV !== 'production',
}

export default NextAuth(authOptions)
