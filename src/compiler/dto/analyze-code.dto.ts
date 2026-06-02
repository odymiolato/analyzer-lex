import { IsString, IsNotEmpty } from 'class-validator';

export class AnalyzeCodeDto {
    @IsString()
    @IsNotEmpty({ message: 'Este campo es obligatorio.' })
    source!: string;

}