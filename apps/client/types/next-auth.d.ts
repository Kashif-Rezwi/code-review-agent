import NextAuth from "next-auth"
import { JWT } from "next-auth/jwt"

declare module "next-auth" {
  interface Session {
    githubToken?: string
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    githubToken?: string
  }
}
