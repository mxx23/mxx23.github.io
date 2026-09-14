/* ==========================================================================
   MP4 封装器 (assets/web/tools/js/mp4-muxer.js)

   WebCodecs 的 VideoEncoder / AudioEncoder 只输出裸编码数据（H.264 的 NAL、
   AAC 的裸帧），没有容器。浏览器自带的 MediaRecorder 能做容器，但它按墙上时钟
   打时间戳、只能实时录制。想「比实时快」就必须走 WebCodecs，也就必须自己封装 MP4。

   本文件输出的结构：
     ftyp (isom / iso2 / avc1 / mp41)
     mdat                          —— 所有样本数据，长度前缀的 NAL / AAC 帧
     moov
       mvhd
       trak video
         tkhd mdia mdhd hdlr minf
           vmhd dinf(dref) stbl(stsd[avc1+avcC] stts stss stsc stsz stco)
       trak audio（可选）
         tkhd mdia mdhd hdlr minf
           smhd dinf(dref) stbl(stsd[mp4a+esds] stts stsc stsz stco)

   用法：
     var mux = new Mp4Muxer()
     mux.setVideoConfig({ codec: 'avc1.42E01E', width, height, description })   // 来自 encoder metadata
     mux.setAudioConfig({ codec: 'mp4a.40.2', sampleRate, numberOfChannels, description })
     mux.addVideoChunk(chunk)     // EncodedVideoChunk
     mux.addAudioChunk(chunk)     // EncodedAudioChunk
     var buf = mux.finalize()     // ArrayBuffer

   说明：不支持 B 帧（不需要 ctts）；每个视频样本都标为关键帧（stss 全列），
   代价是文件略大，换来任意位置都能精确 seek。
   ========================================================================== */
(function (global) {
    'use strict';

    /* ------------------------------------------------------------ 字节工具 */
    function bytesOf (buf) {
        if (buf instanceof Uint8Array) return buf;
        if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
        if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        return new Uint8Array(buf);
    }

    function Writer () {
        this.parts = [];
        this.len = 0;
    }
    Writer.prototype.push = function (b) {
        var u8 = bytesOf(b);
        this.parts.push(u8);
        this.len += u8.length;
        return u8.length;
    };
    Writer.prototype.u8 = function (v) { return this.push(new Uint8Array([v & 0xFF])); };
    Writer.prototype.u16 = function (v) { return this.push(new Uint8Array([(v >> 8) & 0xFF, v & 0xFF])); };
    Writer.prototype.u32 = function (v) {
        return this.push(new Uint8Array([(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]));
    };
    Writer.prototype.u64 = function (v) {
        var hi = Math.floor(v / 4294967296);
        var lo = v >>> 0;
        this.u32(hi); this.u32(lo);
    };
    Writer.prototype.ascii = function (s) {
        var a = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xFF;
        return this.push(a);
    };
    /** 写一个 box：先写内容算出长度，再补上 4 字节 size */
    Writer.prototype.box = function (type, fn) {
        var inner = new Writer();
        if (fn) fn.call(inner, inner);
        var size = 8 + inner.len;
        this.u32(size);
        this.ascii(type);
        if (inner.len) this.push(inner.concat());
        return size;
    };
    Writer.prototype.concat = function () {
        var out = new Uint8Array(this.len);
        var pos = 0;
        for (var i = 0; i < this.parts.length; i++) {
            out.set(this.parts[i], pos);
            pos += this.parts[i].length;
        }
        return out;
    };

    var FULL_BOX = function (version, flags) {
        return function (w) {
            w.u8(version || 0);
            w.u8((flags >> 16) & 0xFF);
            w.u8((flags >> 8) & 0xFF);
            w.u8(flags & 0xFF);
        };
    };

    var MATRIX_IDENTITY = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

    /* ------------------------------------------------------------ 封装器 */
    function Mp4Muxer (opts) {
        opts = opts || {};
        this.timescale = opts.timescale || 1000;
        this.video = null;
        this.audio = null;
        this.videoSamples = [];
        this.audioSamples = [];
        this.videoDurationTicks = 0;
        this.audioDurationTicks = 0;
        this.audioTicksInMovie = 0;
    }

    Mp4Muxer.prototype.setVideoConfig = function (meta) {
        if (!meta || !meta.width || !meta.height) throw new Error('视频配置缺少宽高');
        this.video = {
            codec: meta.codec || 'avc1.42E01E',
            width: meta.width,
            height: meta.height,
            description: meta.description ? bytesOf(meta.description) : null
        };
    };

    Mp4Muxer.prototype.setAudioConfig = function (meta) {
        if (!meta || !meta.sampleRate) throw new Error('音频配置缺少采样率');
        this.audio = {
            codec: meta.codec || 'mp4a.40.2',
            sampleRate: meta.sampleRate,
            channels: meta.numberOfChannels || 1,
            description: meta.description ? bytesOf(meta.description) : null
        };
    };

    Mp4Muxer.prototype.addVideoChunk = function (chunk) {
        if (!this.video) throw new Error('还没有设置视频配置');
        if (!this.video.description && chunk.type === 'key' && chunk.copyTo) {
            /* 有些实现把 SPS/PPS 放在第一个关键帧的前面，这里不做额外解析，
               统一依赖 metadata.decoderConfig.description */
        }
        var data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.videoSamples.push({
            data: data,
            timestampUs: chunk.timestamp,
            durationUs: chunk.duration || 0,
            key: chunk.type === 'key'
        });
    };

    Mp4Muxer.prototype.addAudioChunk = function (chunk) {
        if (!this.audio) throw new Error('还没有设置音频配置');
        var data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.audioSamples.push({
            data: data,
            timestampUs: chunk.timestamp,
            durationUs: chunk.duration || 0
        });
    };

    /** 把时间戳（微秒）翻译成 timescale 下的整数刻度，并补齐每段时长 */
    function toSampleTable (samples, timescale, fallbackDurUs, counter) {
        var rows = [];
        var prevTicks = null;
        for (var i = 0; i < samples.length; i++) {
            var s = samples[i];
            var ticks = Math.round(s.timestampUs * timescale / 1e6);
            var durTicks = s.durationUs ? Math.round(s.durationUs * timescale / 1e6) : fallbackDurUs;
            if (durTicks <= 0) durTicks = fallbackDurUs;
            if (prevTicks != null) {
                var gap = ticks - prevTicks;
                if (gap > 0) rows[rows.length - 1].dur = gap;   /* 用实际间隔修正上一段 */
            }
            rows.push({ size: s.data.length, ticks: ticks, dur: durTicks, data: s.data, key: counter ? counter(s) : false });
            prevTicks = ticks;
        }
        return rows;
    }

    /** 把 duration 相同的连续样本合并成一条 stts 记录 */
    function buildStts (rows) {
        var entries = [];
        for (var i = 0; i < rows.length; i++) {
            var d = rows[i].dur;
            var last = entries[entries.length - 1];
            if (last && last.dur === d) last.count++;
            else entries.push({ count: 1, dur: d });
        }
        return entries;
    }

    Mp4Muxer.prototype.finalize = function () {
        if (!this.video || !this.videoSamples.length) throw new Error('没有可封装的视频样本');

        var ts = this.timescale;
        /* 每帧默认时长：用平均间隔兜底 */
        var vDefaultDur = Math.max(1, Math.round(ts / 30));
        if (this.videoSamples.length > 1) {
            var span = this.videoSamples[this.videoSamples.length - 1].timestampUs - this.videoSamples[0].timestampUs;
            if (span > 0) vDefaultDur = Math.max(1, Math.round(span / (this.videoSamples.length - 1) * ts / 1e6));
        }
        var vRows = toSampleTable(this.videoSamples, ts, vDefaultDur, function (s) { return s.key; });

        var aRows = [];
        var aDefaultDur = 1024;
        if (this.audio && this.audioSamples.length) {
            /* 音轨的 mdhd 刻度就是采样率，一个 AAC 帧 = 1024 个采样。
               （这里千万别再按微秒换算一次——那样每段时长会差几十倍。） */
            aDefaultDur = 1024;
            aRows = toSampleTable(this.audioSamples, this.audio.sampleRate, aDefaultDur);
        }

        /* ---- 先把 ftyp 建好（尺寸固定），据此算出样本的绝对文件偏移 ---- */
        var ftyp = new Writer();
        ftyp.box('ftyp', function (w) {
            w.ascii('isom');
            w.u32(0x200);
            w.ascii('isom'); w.ascii('iso2'); w.ascii('avc1'); w.ascii('mp41');
        });

        /* mdat 数据区起点 = ftyp + mdat 的 8 字节头 */
        var mdatDataStart = ftyp.len + 8;

        var dataW = new Writer();
        function writeSamples (rows, base) {
            var offsets = [];
            for (var i = 0; i < rows.length; i++) {
                offsets.push(base + dataW.len);   /* 绝对偏移 */
                dataW.push(rows[i].data);
            }
            return offsets;
        }
        var vOffsets = writeSamples(vRows, mdatDataStart);
        var aOffsets = aRows.length ? writeSamples(aRows, mdatDataStart) : [];
        var mdatPayload = dataW.concat();

        /* ---- 组装 moov ---- */
        var moov = new Writer();
        var self = this;

        function writeVideoStbl (w) {
            w.box('stbl', function (w2) {
                /* stsd */
                w2.box('stsd', function (w3) {
                    FULL_BOX(0, 0).call(w3, w3);
                    w3.u32(1);
                    w3.box('avc1', function (w4) {
                        /* SampleEntry：6 字节 reserved + 2 字节 data_reference_index */
                        w4.push(new Uint8Array([0, 0, 0, 0, 0, 0]));
                        w4.u16(1);
                        /* VisualSampleEntry 的固定字段（相对 SampleEntry 起点的偏移）：
                             8-9   pre_defined = 0
                            10-11  reserved = 0
                            12-23  pre_defined[3] = 0        (12 字节)
                            24-25  width
                            26-27  height
                            28-35  horizresolution / vertresolution
                            36-39  reserved（合计 4 字节）
                            40-41  frame_count
                            42-73  compressorname（32 字节）
                            74-75  depth
                            76-77  pre_defined = -1
                          即 u16 之外这里必须是 4 + 12 = 16 字节，多写少写都会让后面全部错位。 */
                        w4.u32(0);                          /* pre_defined(2) + reserved(2) */
                        w4.u32(0); w4.u32(0); w4.u32(0);    /* pre_defined[3]：12 字节 */
                        w4.u16(self.video.width);
                        w4.u16(self.video.height);
                        w4.u32(0x00480000);                 /* horizresolution 72dpi */
                        w4.u32(0x00480000);                 /* vertresolution */
                        w4.u32(0);                          /* reserved */
                        w4.u16(1);                          /* frame_count */
                        /* compressorname：32 字节，第一个字节是长度 */
                        var name = 'WebCodecs';
                        var cn = new Uint8Array(32);
                        cn[0] = name.length;
                        for (var i = 0; i < name.length; i++) cn[i + 1] = name.charCodeAt(i);
                        w4.push(cn);
                        w4.u16(0x0018);                     /* depth */
                        w4.u16(0xFFFF);                     /* pre_defined = -1 */
                        /* avcC */
                        var desc = self.video.description;
                        if (!desc) throw new Error('缺少 avcC 配置（encoder metadata.description），无法封装 MP4');
                        w4.box('avcC', function (w5) { w5.push(desc); });
                    });
                });
                /* stts */
                var stts = buildStts(vRows);
                w2.box('stts', function (w3) {
                    FULL_BOX(0, 0).call(w3, w3);
                    w3.u32(stts.length);
                    for (var i = 0; i < stts.length; i++) { w3.u32(stts[i].count); w3.u32(stts[i].dur); }
                });
                /* stss：把关键帧都列出来，保证任意位置可 seek */
                var keys = [];
                for (var k = 0; k < vRows.length; k++) if (vRows[k].key) keys.push(k + 1);
                if (keys.length && keys.length < vRows.length) {
                    w2.box('stss', function (w3) {
                        FULL_BOX(0, 0).call(w3, w3);
                        w3.u32(keys.length);
                        for (var i = 0; i < keys.length; i++) w3.u32(keys[i]);
                    });
                }
                /* stsc：每个 chunk 一个样本 */
                w2.box('stsc', function (w3) {
                    FULL_BOX(0, 0).call(w3, w3);
                    w3.u32(1); w3.u32(1); w3.u32(1); w3.u32(1);
                });
                /* stsz */
                w2.box('stsz', function (w3) {
                    FULL_BOX(0, 0).call(w3, w3);
                    w3.u32(0);                    /* sample_size = 0 表示逐个列出 */
                    w3.u32(vRows.length);
                    for (var i = 0; i < vRows.length; i++) w3.u32(vRows[i].size);
                });
                /* stco */
                w2.box('stco', function (w3) {
                    FULL_BOX(0, 0).call(w3, w3);
                    w3.u32(vOffsets.length);
                    for (var i = 0; i < vOffsets.length; i++) w3.u32(vOffsets[i]);
                });
            });
        }

        function writeVideoTrak (w) {
            w.box('trak', function (w2) {
                w2.box('tkhd', function (w3) {
                    FULL_BOX(0, 0x000007).call(w3, w3);   /* enabled | in movie | in preview */
                    w3.u32(0); w3.u32(0);                 /* creation / modification */
                    w3.u32(1);                            /* track_id */
                    w3.u32(0);                            /* reserved */
                    w3.u32(self.videoDurationTicks);
                    w3.u32(0); w3.u32(0);                 /* reserved[2] */
                    w3.u16(0);                            /* layer */
                    w3.u16(0);                            /* alternate_group */
                    w3.u16(0);                            /* volume = 0（视频） */
                    w3.u16(0);                            /* reserved */
                    for (var i = 0; i < 9; i++) w3.u32(MATRIX_IDENTITY[i]);
                    w3.u32(self.video.width << 16);
                    w3.u32(self.video.height << 16);
                });
                w2.box('mdia', function (w3) {
                    w3.box('mdhd', function (w4) {
                        FULL_BOX(0, 0).call(w4, w4);
                        w4.u32(0); w4.u32(0);
                        w4.u32(ts);
                        w4.u32(self.videoDurationTicks);
                        w4.u16(0x55C4);                  /* language = und */
                        w4.u16(0);
                    });
                    w3.box('hdlr', function (w4) {
                        FULL_BOX(0, 0).call(w4, w4);
                        w4.u32(0);
                        w4.ascii('vide');
                        w4.u32(0); w4.u32(0); w4.u32(0);
                        w4.ascii('VideoHandler');
                        w4.u8(0);
                    });
                    w3.box('minf', function (w4) {
                        w4.box('vmhd', function (w5) {
                            FULL_BOX(0, 1).call(w5, w5);
                            w5.u16(0); w5.u16(0); w5.u16(0); w5.u16(0);
                        });
                        w4.box('dinf', function (w5) {
                            w5.box('dref', function (w6) {
                                FULL_BOX(0, 0).call(w6, w6);
                                w6.u32(1);
                                w6.box('url ', function (w7) { FULL_BOX(0, 1).call(w7, w7); });
                            });
                        });
                        writeVideoStbl(w4);
                    });
                });
            });
        }

        function writeAudioTrak (w) {
            var a = self.audio;
            w.box('trak', function (w2) {
                w2.box('tkhd', function (w3) {
                    FULL_BOX(0, 0x000007).call(w3, w3);
                    w3.u32(0); w3.u32(0);
                    w3.u32(2);                            /* track_id = 2 */
                    w3.u32(0);
                    w3.u32(self.audioTicksInMovie);       /* tkhd 一律用 movie 刻度 */
                    w3.u32(0); w3.u32(0);
                    w3.u16(0); w3.u16(0);
                    w3.u16(0x0100);                       /* volume = 1.0（音频） */
                    w3.u16(0);
                    for (var i = 0; i < 9; i++) w3.u32(MATRIX_IDENTITY[i]);
                    w3.u32(0); w3.u32(0);                 /* 音频轨道宽高为 0 */
                });
                w2.box('mdia', function (w3) {
                    w3.box('mdhd', function (w4) {
                        FULL_BOX(0, 0).call(w4, w4);
                        w4.u32(0); w4.u32(0);
                        w4.u32(a.sampleRate);
                        w4.u32(self.audioDurationTicks);
                        w4.u16(0x55C4);
                        w4.u16(0);
                    });
                    w3.box('hdlr', function (w4) {
                        FULL_BOX(0, 0).call(w4, w4);
                        w4.u32(0);
                        w4.ascii('soun');
                        w4.u32(0); w4.u32(0); w4.u32(0);
                        w4.ascii('SoundHandler');
                        w4.u8(0);
                    });
                    w3.box('minf', function (w4) {
                        w4.box('smhd', function (w5) {
                            FULL_BOX(0, 0).call(w5, w5);
                            w5.u16(0); w5.u16(0);
                        });
                        w4.box('dinf', function (w5) {
                            w5.box('dref', function (w6) {
                                FULL_BOX(0, 0).call(w6, w6);
                                w6.u32(1);
                                w6.box('url ', function (w7) { FULL_BOX(0, 1).call(w7, w7); });
                            });
                        });
                        /* stbl */
                        w4.box('stbl', function (w5) {
                            w5.box('stsd', function (w6) {
                                FULL_BOX(0, 0).call(w6, w6);
                                w6.u32(1);
                                w6.box('mp4a', function (w7) {
                                    w7.push(new Uint8Array([0, 0, 0, 0, 0, 0]));
                                    w7.u16(1);
                                    w7.u32(0); w7.u32(0);       /* reserved */
                                    w7.u16(a.channels);
                                    w7.u16(16);                  /* samplesize */
                                    w7.u16(0); w7.u16(0);        /* pre_defined / reserved */
                                    w7.u32(a.sampleRate << 16);  /* 16.16 定点 */
                                    /* esds：AudioSpecificConfig 放在 DecoderSpecificInfo 里 */
                                    var asc = a.description ? a.description : new Uint8Array([0x12, 0x10]);
                                    var ascLen = asc.length;
                                    var dsiTotal = 2 + ascLen;              /* tag + len + asc */
                                    var slTotal = 1 + 1 + 1;                /* tag + len + 0x02 */
                                    var dcdTotal = 1 + 1 + 1 + 3 + 4 + 4 + slTotal;
                                    var esTotal = 2 + 1 + 1 + 1 + dcdTotal; /* ES_ID(2) + flags(1) + tag + len */
                                    w7.box('esds', function (w8) {
                                        FULL_BOX(0, 0).call(w8, w8);
                                        /* ES_Descriptor */
                                        w8.u8(0x03);
                                        w8.u8(esTotal & 0x7F);
                                        w8.u16(1);                              /* ES_ID */
                                        w8.u8(0);                               /* flags */
                                        /* DecoderConfigDescriptor */
                                        w8.u8(0x04);
                                        w8.u8(dcdTotal & 0x7F);
                                        w8.u8(0x40);                            /* objectTypeIndication = MPEG-4 Audio */
                                        w8.u8(0x15);                            /* streamType=audio(5)<<2 | 1 */
                                        w8.u8(0); w8.u8(0); w8.u8(0);           /* bufferSizeDB */
                                        w8.u32(128000);                         /* maxBitrate */
                                        w8.u32(128000);                         /* avgBitrate */
                                        /* DecoderSpecificInfo */
                                        w8.u8(0x05);
                                        w8.u8(ascLen);
                                        w8.push(asc);
                                        /* SLConfigDescriptor */
                                        w8.u8(0x06);
                                        w8.u8(0x01);
                                        w8.u8(0x02);
                                    });
                                });
                            });
                            var astts = buildStts(aRows);
                            w5.box('stts', function (w6) {
                                FULL_BOX(0, 0).call(w6, w6);
                                w6.u32(astts.length);
                                for (var i = 0; i < astts.length; i++) { w6.u32(astts[i].count); w6.u32(astts[i].dur); }
                            });
                            w5.box('stsc', function (w6) {
                                FULL_BOX(0, 0).call(w6, w6);
                                w6.u32(1); w6.u32(1); w6.u32(1); w6.u32(1);
                            });
                            w5.box('stsz', function (w6) {
                                FULL_BOX(0, 0).call(w6, w6);
                                w6.u32(0);
                                w6.u32(aRows.length);
                                for (var i = 0; i < aRows.length; i++) w6.u32(aRows[i].size);
                            });
                            w5.box('stco', function (w6) {
                                FULL_BOX(0, 0).call(w6, w6);
                                w6.u32(aOffsets.length);
                                for (var i = 0; i < aOffsets.length; i++) w6.u32(aOffsets[i]);
                            });
                        });
                    });
                });
            });
        }
        this.videoDurationTicks = vRows.reduce(function (a, r) { return a + r.dur; }, 0);
        this.audioDurationTicks = aRows.reduce(function (a, r) { return a + r.dur; }, 0);
        /* 音轨的 mdhd 用采样率做刻度，但 tkhd 和 mvhd 都必须是 movie 刻度（ts）。
           少了这一次换算，音轨就会声称有几十上百秒长：播放器放完真实内容后
           画面会一直冻在最后一帧，进度条也拖不动。 */
        this.audioTicksInMovie = this.audio
            ? Math.round(this.audioDurationTicks * ts / this.audio.sampleRate)
            : 0;
        var movieDuration = Math.max(this.videoDurationTicks, this.audioTicksInMovie);

        moov.box('moov', function (w) {
            w.box('mvhd', function (w2) {
                FULL_BOX(0, 0).call(w2, w2);
                w2.u32(0); w2.u32(0);
                w2.u32(ts);
                w2.u32(movieDuration);
                w2.u32(0x00010000);              /* rate 1.0 */
                w2.u16(0x0100);                  /* volume 1.0 */
                w2.u16(0);                       /* reserved */
                w2.u32(0); w2.u32(0);
                for (var i = 0; i < 9; i++) w2.u32(MATRIX_IDENTITY[i]);
                w2.u32(0); w2.u32(0); w2.u32(0); w2.u32(0); w2.u32(0); w2.u32(0);
                w2.u32(3);                       /* next_track_ID */
            });
            writeVideoTrak(w);
            if (aRows.length) writeAudioTrak(w);
        });

        /* ---- 组装成品：ftyp + mdat + moov ---- */
        var out = new Writer();
        out.push(ftyp.concat());
        out.box('mdat', function (w) { w.push(mdatPayload); });
        out.push(moov.concat());

        var fileBytes = out.concat();
        return fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength);
    };

    /* 暴露内部工具便于测试 */
    global.Mp4Muxer = Mp4Muxer;
    global.Mp4MuxerUtils = { Writer: Writer, bytesOf: bytesOf };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { Mp4Muxer: Mp4Muxer, Writer: Writer };
    }
})(typeof window !== 'undefined' ? window : globalThis);
