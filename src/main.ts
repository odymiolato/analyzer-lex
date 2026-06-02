import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const frontendOrigin = process.env.FRONTEND_ORIGIN;
  const allowedOrigins = frontendOrigin
    ? frontendOrigin.split(',').map((origin) => origin.trim()).filter(Boolean)
    : ['http://localhost:3000'];

  app.enableCors({
    origin: allowedOrigins,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.setGlobalPrefix('api');

  const port = Number(process.env.PORT ?? 3020);
  await app.listen(port, '0.0.0.0');
}
bootstrap();
