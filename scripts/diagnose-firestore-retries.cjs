const {setLogFunction} = require(process.cwd() + '/node_modules/firebase-admin/lib/firestore/index.js');
setLogFunction(message => {if (/Retrying transaction|Backing off for|ABORTED|Transaction not eligible/.test(message)) console.error(message.split('\n')[0]);});
