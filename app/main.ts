import * as dgram from "dgram";


//* this is the dns header format
// https://datatracker.ietf.org/doc/html/rfc1035#section-4.1.1
interface DnsHeader {
  id: number;          // 16 bits (2 bytes)
  flags: {
    qr: boolean;       // 1 bit: Query (0) or Response (1)
    opcode: number;    // 4 bits: Type of query
    aa: boolean;       // 1 bit: Authoritative Answer
    tc: boolean;       // 1 bit: Truncated
    rd: boolean;       // 1 bit: Recursion Desired
    ra: boolean;       // 1 bit: Recursion Available
    z: number;         // 3 bits: Reserved
    rcode: number;     // 4 bits: Response code
  };
  qdcount: number;     // 16 bits: Question count
  ancount: number;     // 16 bits: Answer count
  nscount: number;     // 16 bits: Authority count
  arcount: number;  
}

//* this is the dns question format
// https://datatracker.ietf.org/doc/html/rfc1035#section-4.1.2
interface DnsQuestion {
  name : string;
  type : number; // 16 bits: Type of query (e.g., A, AAAA, CNAME)
  Class: number; // 16 bits: Class of query (e.g., IN for Internet)
}

//* this is the dns query format
// https://datatracker.ietf.org/doc/html/rfc1035#section-4.1.3
interface DnsQuery {
  DnsHeader: DnsHeader;
  questions: DnsQuestion[];
  answers: any[]; 
  authorities: any[]; 
  additionals: any[]; 
}

//* function to parse the incomming udp header
const parseDnsHeader = (data: Buffer): DnsHeader => {
  const id = data.readUInt16BE(0);
  const flags = data.readUInt16BE(2);
  // parse flags
  const header: DnsHeader = {
    id,
    flags: {
      qr: (flags & 0x8000) !== 0,     // 1000 0000 0000 0000
      opcode: (flags & 0x7800) >>> 11, // 0111 1000 0000 0000
      aa: (flags & 0x0400) !== 0,     // 0000 0100 0000 0000
      tc: (flags & 0x0200) !== 0,     // 0000 0010 0000 0000
      rd: (flags & 0x0100) !== 0,     // 0000 0001 0000 0000
      ra: (flags & 0x0080) !== 0,     // 0000 0000 1000 0000
      z: (flags & 0x0070) >>> 4,      // 0000 0000 0111 0000
      rcode: flags & 0x000F,          // 0000 0000 0000 1111
    },
    qdcount: data.readUInt16BE(4),
    ancount: data.readUInt16BE(6),
    nscount: data.readUInt16BE(8),
    arcount: data.readUInt16BE(10),
  };
  return header;
};

const parseDnsQuestion = (data : Buffer) : {question : DnsQuestion , offset : number} => {
  let offset:number = 12;
  let i = offset;
  let name = "";
  while (i < data.length && data[i] !== 0 ){
    if (data[i] == 0x0 ) {
      break;
    }
    let labelLength = data[i];
    if (name.length > 0 ) {
      name += '.';
    }
    name += data.toString('ascii', i+1 , i+1+labelLength);
    i += labelLength+1
  }
  offset = i+1;
  const type = data.readUInt16BE(offset);
  const Class = data.readUInt16BE(offset+2);
  const question : DnsQuestion  = {
    name : name,
    type : type,
    Class : Class
  }
  return {question , offset};
};

const createDnsResponse = (query:Buffer) : Buffer => {
  const header = parseDnsHeader(query);
  const {question, offset} = parseDnsQuestion(query);

  const response = Buffer.alloc(512);
  query.copy(response); 
  let flags = 0;
  flags |= 0x8000;                    // Set QR bit to 1 (Response)
  flags |= (header.flags.opcode << 11);  // Preserve the opcode

  response.writeUInt16BE(header.id, 0); 
  response.writeUInt16BE(flags, 2);      
  
  // Set counts
  response.writeUInt16BE(header.qdcount, 4);
  response.writeUInt16BE(1, 6);          
  response.writeUInt16BE(0, 8);            
  response.writeUInt16BE(0, 10);            
  response.writeUInt32BE(0x3C, offset);
  response.writeUInt16BE(0x4, offset); // Pointer to the question name
  return response;
}

const udpSocket: dgram.Socket = dgram.createSocket("udp4");
udpSocket.bind(2053, "127.0.0.1");

udpSocket.on("message", (data: Buffer, remoteAddr: dgram.RemoteInfo) => {
  try {
    console.log(`Received data from ${remoteAddr.address}:${remoteAddr.port}`);

    const response = createDnsResponse(data);
    udpSocket.send(response, remoteAddr.port, remoteAddr.address);
  } catch (e) {
    console.log(`Error sending data: ${e}`);
  }
});
