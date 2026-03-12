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
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { RagService } from './rag.service'

const ALLOWED_MIME_TYPES = ['text/plain', 'application/pdf', 'text/markdown']
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB

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
    async upload(@UploadedFile() file: Express.Multer.File) {
        if (!file) {
            throw new BadRequestException('No file provided.')
        }

        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            throw new BadRequestException(
                `Unsupported file type "${file.mimetype}". Upload a .txt or .pdf file.`,
            )
        }

        return this.ragService.ingest(file.buffer, file.mimetype, file.originalname)
    }

    // GET /rag/documents
    @Get('documents')
    listDocuments() {
        return this.ragService.listDocuments()
    }

    // DELETE /rag/documents/:id
    @Delete('documents/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteDocument(@Param('id') id: string) {
        await this.ragService.deleteDocument(id)
    }
}
