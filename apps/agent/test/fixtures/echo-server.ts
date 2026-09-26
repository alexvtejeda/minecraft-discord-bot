// Stand-in for a Minecraft server: announces Done, echoes each command, exits on "stop".
console.log('[Server thread/INFO]: Done (1.234s)! For help, type "help"');
for await (const line of console) {
  console.log(`got ${line}`);
  if (line === "stop") process.exit(0);
}

export {};
