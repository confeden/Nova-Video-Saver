# Сторонние компоненты

Nova Video Saver (ранее Nova Youtube Downloader) основан на [HelpFreedom/Triangle-Downloader](https://github.com/HelpFreedom/Triangle-Downloader), распространяемом по лицензии GNU GPL v3.0. Код был изменён и расширен в 2026 году. Полный текст GPL v3.0 находится в файле [LICENSE](LICENSE).

В проект включена версия [ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), распространяемая по лицензии MIT:

MIT License

Copyright (c) 2019 Jerome Wu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Встроенное ядро содержит [FFmpeg](https://github.com/FFmpeg/FFmpeg) с включёнными `--enable-gpl` и `libx264`, поэтому эта сборка распространяется по GPL v2.0 или более поздней версии. Исходный код и сценарии сборки соответствующей версии `ffmpeg.wasm` доступны в [теге v0.12.6](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.6). Условия FFmpeg приведены в его [файле лицензии](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md).

В проект включён неизменённый однофайловый бандл [Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny) версии 1.51.0 (`extension/vendor/mediabunny/mediabunny.min.mjs`), распространяемый по лицензии [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/). MPL-2.0 совместима с GPL v3.0; при изменении файлов самой библиотеки такие изменения должны публиковаться на условиях MPL-2.0. Библиотека используется для аппаратного перекодирования видео через WebCodecs.
