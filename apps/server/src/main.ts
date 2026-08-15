import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import type { IncomingMessage } from 'http'
import { json, urlencoded } from 'express'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, bodyParser: false })

  app.use(
    json({
      limit: '1mb',
      verify: (req: IncomingMessage & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf
      },
    }),
  )
  app.use(urlencoded({ extended: true, limit: '1mb' }))

  // RZC-008: Trust upstream reverse proxy (Cloudflare/Vercel/Render) for accurate req.ip in Throttler
  app.set('trust proxy', 1)

  app.useGlobalPipes(new ValidationPipe({ whitelist: true }))


  const frontendUrl = process.env.FRONTEND_URL?.replace(/\/$/, '') || 'http://localhost:3000'

  // localhost is a dev convenience — never trust it in production
  const allowedOrigins =
    process.env.NODE_ENV === 'production'
      ? [frontendUrl]
      : [frontendUrl, 'http://localhost:3000']

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  })

  // Drain Prisma/Redis/BullMQ cleanly on SIGTERM (every Render deploy sends one)
  app.enableShutdownHooks()

  const port = process.env.PORT ?? 4000
  await app.listen(port)
  console.log(`Server running on port ${port}`)
}
void bootstrap()
