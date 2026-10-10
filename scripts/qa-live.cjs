const {chromium} = require('playwright');
const fs=require('node:fs'), assert=require('node:assert/strict');
const BASE='https://zaki064.github.io/zaki-visual-portfolio/';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome'});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 const page=await context.newPage();const errors=[];const failures=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('requestfailed',r=>failures.push({url:r.url(),error:r.failure()?.errorText}));
 await page.goto(BASE+'?build=stream-v2',{waitUntil:'domcontentloaded'});
 await page.waitForSelector('video[data-stream]',{timeout:30000});
 assert.equal(await page.locator('video[data-stream]').count(),33);
 await page.locator('[data-enable-audio]').click();
 const enter=async()=>{
   await page.evaluate(()=>{const r=document.querySelector('.cinema-stage').getBoundingClientRect();scrollTo(0,scrollY+r.top-innerHeight/2+r.height/2);});
   await page.waitForFunction(()=>{const v=document.querySelector('video');return !v.paused&&v.readyState>=3&&v.videoWidth>0;},null,{timeout:30000});
 };
 const start=Date.now(); await enter();
 const first=await page.locator('video').first().evaluate(v=>({width:v.videoWidth,height:v.videoHeight,muted:v.muted,time:v.currentTime,paused:v.paused}));
 assert.equal(first.width,5076);assert.equal(first.height,2160);assert.equal(first.muted,false);
 const startMs=Date.now()-start;
 // Wait until a real fragment from the media branch has played, not just the startup fragment.
 await page.waitForFunction(()=>document.querySelector('video').currentTime>3,null,{timeout:30000});
 await page.evaluate(()=>scrollTo(0,document.querySelector('#work').offsetTop+900));
 await page.waitForFunction(()=>document.querySelector('video').paused);
 const downExit=await page.locator('video').first().evaluate(v=>({paused:v.paused,time:v.currentTime}));assert(downExit.time<.1);
 await enter();
 const returnUp=await page.locator('video').first().evaluate(v=>({paused:v.paused,muted:v.muted,time:v.currentTime}));assert(!returnUp.paused);assert(!returnUp.muted);
 await page.evaluate(()=>scrollTo(0,0));
 await page.waitForFunction(()=>document.querySelector('video').paused);
 const upExit=await page.locator('video').first().evaluate(v=>({paused:v.paused,time:v.currentTime}));assert(upExit.time<.1);
 const galleries=[];
 // Test every actual video, sequentially, with hover as the only play action.
 for(let i=1;i<33;i++){
   const video=page.locator('video[data-stream]').nth(i), player=video.locator('..');
   console.log('CHECK',i,await video.getAttribute('data-stream'));
   await page.mouse.move(5,5);
   await player.scrollIntoViewIfNeeded();
   await player.hover();
   await page.waitForFunction(index=>{const v=document.querySelectorAll('video')[index];return !v.paused&&v.readyState>=3&&v.videoWidth>0;},i,{timeout:30000});
   const state=await video.evaluate(v=>({label:v.getAttribute('aria-label'),width:v.videoWidth,height:v.videoHeight,muted:v.muted,paused:v.paused,error:v.error?.code||null}));
   assert.equal(state.muted,false);assert.equal(state.error,null);
   console.log('PLAYING',JSON.stringify(state));
   await page.waitForFunction(()=>[...document.querySelectorAll('video')].filter(v=>!v.paused).length===1,null,{timeout:5000});
   galleries.push(state);
   await page.mouse.move(5,5);
   await page.waitForFunction(index=>document.querySelectorAll('video')[index].paused,i);
 }
 const layouts=[];
 for(const width of [360,390,430,768]){
   const c=await browser.newContext({viewport:{width,height:844},isMobile:width<768,hasTouch:width<768,deviceScaleFactor:1});
   const p=await c.newPage();await p.goto(BASE+'?build=stream-v2',{waitUntil:'domcontentloaded'});
   const layout=await p.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,frames:[...document.querySelectorAll('.collection-picture,.archive-media')].map(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}))}));
   assert(layout.scrollWidth<=layout.width+1,`Horizontal overflow at ${width}`);
   assert(layout.frames.every(f=>f.left>=-1&&f.right<=layout.width+1),`Media alignment at ${width}`);
   layouts.push({width,scrollWidth:layout.scrollWidth,frames:layout.frames.length});
   if(width===390){await p.screenshot({path:'qa-mobile.png'});}
   await c.close();
 }
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'qa-desktop.png'});
 assert.equal(errors.length,0,errors.join('\n'));
 const report={first,startMs,downExit,returnUp,upExit,galleries,layouts,errors,failures};
 fs.writeFileSync('qa-live-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
