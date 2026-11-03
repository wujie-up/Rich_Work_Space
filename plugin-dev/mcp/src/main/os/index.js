import mac from './mac/computer.js';
import linux from './linux/computer.js';
export default process.platform === 'darwin' ? mac : linux;
