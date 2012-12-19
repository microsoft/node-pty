var net = require('net');

/**
 * PipeWriter
 * 
 * Is used when communicating with the control socket
 * in agent.exe
 * 
 */
function PipeWriter(socket, encoding) {
    this.socket = socket; 
    this.packets = [];
}

// Writes a int32 value
PipeWriter.prototype.putInt = function (value) {
    this.packets.push({
        byteLength: 4,
        value: value,
        type: 'writeInt32LE',
        offset: { start: 0, end: 0}
    }); 
    return this;
}

// Writes a wchar_t string
PipeWriter.prototype.putWString = function (string) {
    var value = string + '\0',
        byteLength = Buffer.byteLength(value, 'ucs2');
    this.putInt(byteLength);
    this.packets.push({
        byteLength: byteLength,
        value: value,
        type: 'ucs2',
        offset: { start: 0, end: 0}
    }); 
    return this; 
}

// Writes the actual command with corresponding data
PipeWriter.prototype.flush = function () {
    
    var self = this,
        buffer = new Buffer(this.getTransportSize()),
        offset = 0,
        command;
    
    // Number of bytes to send
    buffer.writeInt32LE(buffer.length, offset); 
    offset += 4;
    
    // Get command type
    command = this.packets.shift();
    
    // Write command type
    buffer.writeInt32LE(command.value, offset); 
    offset += command.byteLength;

    // Write all remaining packets
    if(this.packets.length) {
        this.packets.forEach(function(packet) {
            switch(packet.type) {
                case 'writeInt32LE':
                    buffer.writeInt32LE(packet.value, offset);
                    packet.offset.start = offset;
                    packet.offset.end = packet.byteLength + offset;
                    offset += packet.byteLength;
                break;
                case 'ucs2': 
                    buffer.write(packet.value, offset, 'ascii');
                    packet.offset.start = offset; 
                    packet.offset.end = packet.byteLength + offset;
                    offset += packet.byteLength;
                break;
                default:
                    throw new Error("Unknown packet type");
                break;
            } 
        });
    } 
    
    // Write buffer
    this.socket.write(buffer);
    
    // Reset transport
    this.packets = [];

}

PipeWriter.prototype.getTransportSize = function () {
    var self = this, total = 0;
    this.packets.forEach(function(packet) {
       total += packet.byteLength;
    });
    return total + 4;
}

/**
 * Testcase
 * 
 * UTF-8 decoded
 * 
 *  Size of transport: 138 (Data: 138)
 *  Command:  127
 *  string #1:     c m d . e x e 1
 *  string #2:     c m d . e x e 1 1
 *  string #3:     c m d . e x e 1 1 1
 *  string #4:     c m d . e x e 1 1 1 1
 *  string #5:     c m d . e x e 1 1 1 1 1
 * 
 * Should yield:
 * 
 *  * UTF-8 decoded
 * 
 *  Size of transport: 138 (Data: 138)
 *  Command:  127
 *  string #1: cmd.exe1
 *  string #2: cmd.exe11
 *  string #3: cmd.exe111
 *  string #4: cmd.exe1111
 *  string #5: cmd.exe11111
 * 
 */

var pipeName = '\\\\.\\pipe\\test123';

net.createServer(function(socket) {
    socket.on('data', function(data) {
        var transportSize = data.readInt32LE(0),
            command = data.readInt32LE(4),
            offset = 8,
            getWString = function() {
                var len = data.readInt32LE(offset),
                    // end of string
                    end = offset + len + 4; 
                    // string result
                    actual = data.slice(offset + 1, end);
                // next string length 
                offset = end; 
                return actual.toString('utf8');
            };
        console.log("Size of transport: %s (Data: %s)", transportSize, data.length);
        console.log("Command: ", command);
        console.log("string #1: ", getWString()); 
        console.log("string #2: ", getWString()); 
        console.log("string #3: ", getWString()); 
        console.log("string #4: ", getWString()); 
        console.log("string #5: ", getWString()); 
    });
}).listen(pipeName);

var socket = net.connect({ path: pipeName }, function() {
   var Command = 127,
     p = new PipeWriter(socket)
    .putInt(Command)
    .putWString("cmd.exe1")
    .putWString("cmd.exe11")
    .putWString("cmd.exe111")
    .putWString("cmd.exe1111")
    .putWString("cmd.exe11111")
    .flush();
});