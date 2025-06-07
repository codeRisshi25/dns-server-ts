import dgram from 'dgram';

// --- Configuration ---
const DNS_SERVER_IP = "8.8.8.8";
const DNS_SERVER_PORT = 53;
const DOMAIN_TO_QUERY = "google.com";


const udpSocket:dgram.Socket = dgram.createSocket('udp4');
udpSocket.bind(8053,'127.0.0.1',()=>{
    console.log("Listening on port 127.0.0.1:8080")
})

udpSocket.on('message',(data:Buffer , remoteAddr:dgram.RemoteInfo)=>{
    try {
        
    } catch (error) {
        
    }
})