import http from 'node:http';
const req = http.get({host:'127.0.0.1',port:3000,path:'/wiki/',timeout:8000}, (res)=>{
  let body='';
  res.on('data',c=>body+=c);
  res.on('end',()=>{
    const m = body.match(/assets\/index-[A-Za-z0-9_]+\.js/);
    console.log('STATUS', res.statusCode);
    console.log('BUNDLE', m?m[0]:'NONE');
    process.exit(0);
  });
});
req.on('error',e=>{console.log('ERR', e.message);process.exit(2);});
req.on('timeout',()=>{console.log('TIMEOUT');req.destroy();process.exit(3);});
