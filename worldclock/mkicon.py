# Generates worldclock.ico (16/32/48 px) with a simple clock face. Pure Python, no deps.
import struct, math
def render(n):
    ss=4; N=n*ss; c=(N-1)/2; R=N*0.46
    px=[]
    for y in range(n):
        for x in range(n):
            acc=[0,0,0,0]
            for sy in range(ss):
                for sx in range(ss):
                    X=x*ss+sx-c; Y=y*ss+sy-c; d=math.hypot(X,Y)
                    col=None
                    if d<=R:
                        col=(60,140,255) if d>R*0.84 else (30,32,38)
                        # hands: hour -> 10 o'clock-ish, minute -> 2 o'clock
                        for ang,ln,w in ((math.radians(-60),0.70,0.10),(math.radians(-150),0.48,0.12)):
                            ux,uy=math.cos(ang),math.sin(ang)
                            t=X*ux+Y*uy; p=abs(-X*uy+Y*ux)
                            if -R*0.05<=t<=R*ln and p<=R*w/2: col=(240,240,240)
                        if d<R*0.10: col=(60,140,255)
                    if col:
                        acc[0]+=col[2];acc[1]+=col[1];acc[2]+=col[0];acc[3]+=255
            k=ss*ss; a=acc[3]//k
            if a: px.append(bytes([acc[0]//(acc[3]//255) if acc[3] else 0, acc[1]//(acc[3]//255), acc[2]//(acc[3]//255), a]))
            else: px.append(b'\0\0\0\0')
    rows=[b''.join(px[r*n:(r+1)*n]) for r in range(n)][::-1]
    xor=b''.join(rows); andmask=b'\0'*(((n+31)//32)*4*n)
    hdr=struct.pack('<IiiHHIIiiII',40,n,n*2,1,32,0,len(xor)+len(andmask),0,0,0,0)
    return hdr+xor+andmask
sizes=[16,24,32,48]; imgs=[render(s) for s in sizes]
out=struct.pack('<HHH',0,1,len(sizes)); off=6+16*len(sizes)
for s,im in zip(sizes,imgs):
    out+=struct.pack('<BBBBHHII',s,s,0,0,1,32,len(im),off); off+=len(im)
open('worldclock.ico','wb').write(out+b''.join(imgs))
