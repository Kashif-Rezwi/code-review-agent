import { Controller, Get } from '@nestjs/common'
import { GithubService } from './github/github.service'

@Controller('health')
export class HealthController {
  constructor(private readonly githubService: GithubService) {}

  @Get()
  check() {
    const githubToken = this.githubService.getTokenHealth()
    return {
      status: githubToken === 'invalid' ? 'degraded' : 'ok',
      githubToken,
    }
  }
}
