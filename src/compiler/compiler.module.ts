import { Module } from '@nestjs/common';
import { CompilerService } from './compiler.service';
import { BuildService } from './build.service';
import { CompilerController } from './compiler.controller';

@Module({
  controllers: [CompilerController],
  providers: [CompilerService, BuildService],
})
export class CompilerModule {}
