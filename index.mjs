import { createRequire } from 'module';
var require = createRequire(import.meta.url);
var createDB = require('./index.js');
export default createDB;
