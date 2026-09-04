import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "../src/renderer/core/clock.js";
import { SignalMapper } from "../src/renderer/core/signal-mapper.js";

function metrics(overrides={}) {
  return {
    cpuUsagePercent:10,gpuUsagePercent:null,memoryUsagePercent:50,
    diskReadBps:0,diskWriteBps:0,diskActivityDevice:null,
    diskBusyPercent:null,diskLatencyMs:null,diskPressureDevice:null,
    networkRxBps:0,networkTxBps:0,networkActivityInterface:null,
    cursorFeedback:"normal",cursorFeedbackDetail:null,cursorFeedbackToken:null,userIdleSeconds:null,
    ...overrides,
  };
}

function sample(mapper, clock, override, seconds=1){let s; for(let i=0;i<seconds;i++){clock.advance(1000);s=mapper.update(metrics(override));}return s;}

test("disk copy tail exits by relative decay and does not reenter while draining",()=>{
  const clock=new FakeClock(); const mapper=new SignalMapper({clock});
  mapper.update(metrics({diskWriteBps:500_000_000}));
  let s=sample(mapper,clock,{diskWriteBps:500_000_000},3);
  assert.equal(s.load?.source,"disk_active");
  s=sample(mapper,clock,{diskWriteBps:70_000_000},1); assert.equal(s.load?.source,"disk_active");
  s=sample(mapper,clock,{diskWriteBps:55_000_000},1); assert.equal(s.load?.source,"disk_active");
  s=sample(mapper,clock,{diskWriteBps:45_000_000},1); assert.equal(s.load?.source,"disk_active");
  s=sample(mapper,clock,{diskWriteBps:40_000_000},1); assert.equal(s.load,null);
  assert.equal(mapper.getDiagnostics().gates.disk.draining,true);
  s=sample(mapper,clock,{diskWriteBps:90_000_000},4); assert.equal(s.load,null);
  assert.equal(mapper.getDiagnostics().gates.disk.draining,true);
  s=sample(mapper,clock,{diskWriteBps:300_000_000},4);
  assert.equal(s.load?.source,"disk_active");
});

test("disk pressure catches low throughput storage contention",()=>{
  const clock=new FakeClock(); const mapper=new SignalMapper({clock});
  mapper.update(metrics({diskWriteBps:500_000,diskBusyPercent:82,diskLatencyMs:31,diskPressureDevice:"Disk 0"}));
  let s=sample(mapper,clock,{diskWriteBps:500_000,diskBusyPercent:82,diskLatencyMs:31,diskPressureDevice:"Disk 0"},2);
  assert.equal(s.load?.source,"disk_pressure");
  assert.equal(mapper.getDiagnostics().values.diskPressureDevice,"Disk 0");
  s=sample(mapper,clock,{diskWriteBps:500_000,diskBusyPercent:20,diskLatencyMs:4},3);
  assert.equal(s.load,null);
});

test("cursor feedback maps busy and background working with one-second exit debounce",()=>{
  const clock=new FakeClock(); const mapper=new SignalMapper({clock});
  let s=mapper.update(metrics({cursorFeedback:"busy",cursorFeedbackDetail:"IDC_WAIT"}));
  assert.equal(s.pressure?.state,"waiting"); assert.equal(s.pressure?.source,"cursor_busy");
  clock.advance(1000);
  s=mapper.update(metrics({cursorFeedback:"background_working",cursorFeedbackDetail:"IDC_APPSTARTING"}));
  assert.equal(s.pressure?.source,"cursor_busy");
  clock.advance(1000);
  s=mapper.update(metrics({cursorFeedback:"background_working",cursorFeedbackDetail:"IDC_APPSTARTING"}));
  assert.equal(s.pressure,null); assert.equal(s.load?.state,"running"); assert.equal(s.load?.source,"cursor_background_working");
});

test("memory pressure remains ahead of cursor busy",()=>{
  const clock=new FakeClock(); const mapper=new SignalMapper({clock});
  mapper.update(metrics({memoryUsagePercent:95,cursorFeedback:"busy"}));
  let s=sample(mapper,clock,{memoryUsagePercent:95,cursorFeedback:"busy"},12);
  assert.equal(s.pressure?.source,"memory_pressure"); assert.equal(s.pressure?.state,"failed");
});
