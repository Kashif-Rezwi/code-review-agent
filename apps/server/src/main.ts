import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  app.useGlobalPipes(new ValidationPipe({ whitelist: true }))

  // Remove trailing slashes from the environment variable if they exist
  const frontendUrl = process.env.FRONTEND_URL?.replace(/\/$/, '') || 'http://localhost:3000'

  app.enableCors({
    origin: [frontendUrl, 'http://localhost:3000'],
    credentials: true,
  })

  await app.listen(process.env.PORT ?? 4000)
  console.log('Server running on port 4000')
}
bootstrap()