import {
    Controller,
    Post,
    Get,
    Delete,
    Param,
    UploadedFile,
    UseInterceptors,
    BadRequestException,
    HttpCode,
    HttpStatus,
    UseGuards,
    Req,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Request } from 'express'
import { RagService } from './rag.service'
import { AuthGuard } from '../auth/auth.guard'

const ALLOWED_MIME_TYPES = ['text/plain', 'application/pdf', 'text/markdown']
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB

@UseGuards(AuthGuard)
@Controller('rag')
export class RagController {
    constructor(private readonly ragService: RagService) {}

    // POST /rag/upload
    @Post('upload')
    @HttpCode(HttpStatus.CREATED)
    @UseInterceptors(
        FileInterceptor('file', {
            limits: { fileSize: MAX_FILE_SIZE },
        }),
    )
    async upload(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
        if (!file) {
            throw new BadRequestException('No file provided.')
        }

        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            throw new BadRequestException(
                `Unsupported file type "${file.mimetype}". Upload a .txt, .md, or .pdf file.`,
            )
        }

        return this.ragService.ingest(file.buffer, file.mimetype, file.originalname, req.user!.userId)
    }

    // GET /rag/documents
    @Get('documents')
    listDocuments(@Req() req: Request) {
        return this.ragService.listDocuments(req.user!.userId)
    }

    // DELETE /rag/documents/:id
    @Delete('documents/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteDocument(@Param('id') id: string, @Req() req: Request) {
        await this.ragService.deleteDocument(id, req.user!.userId)
    }
}
