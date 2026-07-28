
# A multi-power function solver
# returns roots for function of type Xx^2 + Yx + Z
def solver(self, params):
    #l = len(params)
    a = params[0]
    b = params[1]
    c = params[2]
    r1 = (-b + sqrt(4*b - a*c)) / 2*a
    r2 = (-b - sqrt(4*b - a*c)) / 2*a
    return [r1,r2]

x = 0

params = []
for _ in range(3):
    x = input("num of curr: ")
    params.append(x)
roots = solver(params)

print(roots)