// converter.js

(async function() {
  const { Muxer, ArrayBufferTarget } = WebMMuxer;
  const { createFile: createMP4BoxFile } = MP4Box;

  // UI refs
  const drop = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const progWrap = document.getElementById('progress-container');
  const bar = document.getElementById('progress-bar');
  const status = document.getElementById('status-text');
  const out = document.getElementById('output');

  function reset() {
    bar.style.width = '0%';
    status.textContent = '';
    progWrap.classList.add('hidden');
    out.innerHTML = '';
    drop.classList.remove('disabled');
    drop.textContent = 'Drag & drop an MP4 here, or click to select';
  }
  function upd(p, msg='') {
    bar.style.width = `${p}%`;
    status.textContent = msg;
  }
  reset();

  // wire up
  ;['dragover','dragleave','drop'].forEach(evt =>
    drop.addEventListener(evt, e => {
      e.preventDefault();
      drop.classList.toggle('dragover', evt==='dragover');
      if (evt==='drop' && e.dataTransfer.files[0]) start(e.dataTransfer.files[0]);
    })
  );
  drop.addEventListener('click', ()=>fileInput.click());
  fileInput.addEventListener('change', ()=> fileInput.files[0] && start(fileInput.files[0]));

  async function start(file) {
    if (!file.name.match(/\.mp4$/i)) {
      return alert('Pick an MP4 file');
    }
    drop.classList.add('disabled');
    progWrap.classList.remove('hidden');
    upd(0,'Reading file…');

    // demux
    const { track, samples } = await demux(file);
    const total = samples.length;
    upd(10,'Demuxed');

    // build decoder config
    const decCfg = { codec: track.codec };
    if (track.video) {
      decCfg.codedWidth = track.video.width;
      decCfg.codedHeight = track.video.height;
    }
    // H264 SPS/PPS
    if (track.codec.startsWith('avc1')) {
      let spspps;
      if (track.avcC) {
        const pre = new Uint8Array([0,0,0,1]), parts=[];
        track.avcC.sequenceParameterSets.forEach(x=>parts.push(pre,new Uint8Array(x)));
        track.avcC.pictureParameterSets.forEach(x=>parts.push(pre,new Uint8Array(x)));
        spspps = concat(parts).buffer;
      } else {
        spspps = extractSpsPps(samples[0].data);
      }
      if (!spspps) throw new Error('No SPS/PPS');
      decCfg.description = spspps;
    }
    // other codecs
    if (track.codec.startsWith('hvc1') && track.hvcC?.buffer) decCfg.description = track.hvcC.buffer;
    if (track.codec.startsWith('vp09') && track.vpcC?.buffer) decCfg.description = track.vpcC.buffer;
    if (track.codec.startsWith('av01') && track.av1C?.buffer) decCfg.description = track.av1C.buffer;

    // support checks & fallback
    upd(20,'Checking support…');
    let s = await VideoDecoder.isConfigSupported(decCfg);
    if (!s.supported && track.codec.startsWith('avc1')) {
      decCfg.codec = 'avc1.42001E';
      s = await VideoDecoder.isConfigSupported(decCfg);
    }
    if (!s.supported) throw new Error(`Cannot decode ${decCfg.codec}`);

    // encoder config
    const encCfg = { codec:'vp8',
      width: track.video.width,
      height: track.video.height,
      bitrate: track.bitrate||1e6,
      framerate: 30
    };
    const eok = await VideoEncoder.isConfigSupported(encCfg);
    if (!eok.supported) throw new Error('Cannot encode VP8');

    // init muxer/codec
    upd(30,'Init codecs…');
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec:'V_VP8',
        width:track.video.width, height:track.video.height }
    });

    let count=0;
    const decoder = new VideoDecoder({
      output: frame=>{
        encoder.encode(frame);
        frame.close();
        upd(30 + (++count/total)*60,`Frame ${count}/${total}`);
      },
      error:e=>{throw e}
    });
    decoder.configure(decCfg);

    const encoder = new VideoEncoder({
      output: (chunk, meta)=> muxer.addVideoChunk(chunk, meta),
      error:e=>{throw e}
    });
    encoder.configure(encCfg);

    // decode→encode loop
    upd(40,'Transcoding…');
    for (const s of samples) {
      const chk = new EncodedVideoChunk({
        type: s.is_rap?'key':'delta',
        timestamp: Math.round(s.cts*1e6/track.timescale),
        data: new Uint8Array(s.data)
      });
      decoder.decode(chk);
    }

    // flush & finalize
    await decoder.flush();
    await encoder.flush();
    upd(95,'Finalizing…');
    const webm = muxer.finalize();
    const blob = new Blob([webm],{type:'video/webm'});
    const url  = URL.createObjectURL(blob);
    const name = file.name.replace(/\.mp4$/i,'.webm');

    out.innerHTML = `<a href="${url}" download="${name}">Download WebM</a>`;
    upd(100,'Done');
  }

  // demux via mp4box
  async function demux(file) {
    const ab = await file.arrayBuffer();
    ab.fileStart = 0;
    const mp4 = createMP4BoxFile();
    let ti, sam=[];
    return new Promise((res,rej)=>{
      mp4.onError=e=>rej(e);
      mp4.onReady=info=>{
        ti=info.tracks.find(t=>t.video);
        if (!ti) return rej('no video');
        mp4.setExtractionOptions(ti.id,null,{nbSamples:ti.nb_samples});
        mp4.start();
      };
      mp4.onSamples=(_,__,arr)=>sam.push(...arr);
      try{
        mp4.appendBuffer(ab);
        mp4.flush();
      }catch(e){rej(e);}
      (function w(){
        if (ti && sam.length>=ti.nb_samples) res({track:ti,samples:sam});
        else setTimeout(w,50);
      })();
    });
  }

  // helper: extract SPS/PPS
  function extractSpsPps(buf){
    const dv=new DataView(buf), parts=[],pre=new Uint8Array([0,0,0,1]);
    let o=0;
    while(parts.length<2 && o+4<dv.byteLength){
      const sz=dv.getUint32(o);o+=4;
      if (o+sz>dv.byteLength)break;
      const nal=new Uint8Array(buf,o,sz);
      const t=nal[0]&0x1f;
      if(t===7||t===8)parts.push(pre,nal);
      o+=sz;
    }
    return parts.length===2?concat(parts).buffer:null;
  }

  function concat(arr){
    let l=0;arr.forEach(a=>l+=a.length);
    const out=new Uint8Array(l);let p=0;
    for(const a of arr){out.set(a,p);p+=a.length;}
    return out;
  }

})();
